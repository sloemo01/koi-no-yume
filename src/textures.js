// Every sprite in the pond is painted here, pixel by pixel, at runtime.
// Nothing is loaded from disk. Sprites are painted on small offscreen
// canvases, outlined, then alpha-hardened so upscaling stays crisp.
"use strict";

const TEXTURES = (() => {
  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    return { c, ctx };
  }

  function px(ctx, x, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
  }

  function solid(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  }

  function ellipse(ctx, x, y, rx, ry, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, TAU);
    ctx.fill();
  }

  // snap alpha to 0 or 255 so the pixel grid never blurs on upscale
  function harden(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) {
      d[i] = d[i] >= 127 ? 255 : 0;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // a 1px border grown outward from the silhouette (4-neighbour dilation)
  function outline(canvas, color, alphaThreshold = 40) {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const solidAt = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] >= alphaThreshold;
    const marks = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] >= alphaThreshold) continue;
        if (solidAt(x - 1, y) || solidAt(x + 1, y) || solidAt(x, y - 1) || solidAt(x, y + 1)) {
          marks.push(x, y);
        }
      }
    }
    const rgb = hexToRgb(color);
    for (let i = 0; i < marks.length; i += 2) {
      const o = (marks[i + 1] * w + marks[i]) * 4;
      d[o] = rgb[0];
      d[o + 1] = rgb[1];
      d[o + 2] = rgb[2];
      d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // column extents (above/below the spine row), normalised to 0..1 of height.
  // The fish bend mesh rides exactly on this silhouette, so fins and tails
  // survive any bend without being squashed.
  function measureExtents(canvas, spineRow) {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, w, h).data;
    const out = new Float32Array(w * 2);
    for (let x = 0; x < w; x++) {
      let top = spineRow;
      let bot = spineRow;
      let found = false;
      for (let y = 0; y < h; y++) {
        if (d[(y * w + x) * 4 + 3] > 0) {
          if (!found) { top = y; bot = y; found = true; }
          else if (y > bot) bot = y;
        }
      }
      if (!found) { top = spineRow - 1; bot = spineRow + 1; }
      out[x * 2] = (spineRow - top) / h;
      out[x * 2 + 1] = (bot - spineRow) / h;
    }
    return out;
  }

  function extentsAt(ext, u) {
    const n = ext.length / 2;
    const f = clamp(u, 0, 1) * (n - 1);
    return [ext[Math.floor(f) * 2], ext[Math.floor(f) * 2 + 1]];
  }

  // ---------------------------------------------------------------- koi

  // Half-width of the body at t along it (0 = snout, 1 = tail root). Blunt
  // snout, widest just behind the head, then one steady taper. At this size
  // the profile is what separates a fish from a sausage.
  const KOI_BODY_PROFILE = [
    [0, 0.44], [0.06, 0.82], [0.16, 0.97], [0.34, 1.0],
    [0.56, 0.93], [0.74, 0.74], [0.88, 0.5], [1, 0.3],
  ];

  function bodyHalfAt(t) {
    for (let i = 0; i < KOI_BODY_PROFILE.length - 1; i++) {
      const [t0, h0] = KOI_BODY_PROFILE[i];
      const [t1, h1] = KOI_BODY_PROFILE[i + 1];
      if (t <= t1) {
        const k = smoothstep(t0, t1, t);
        return lerp(h0, h1, k);
      }
    }
    return KOI_BODY_PROFILE[KOI_BODY_PROFILE.length - 1][1];
  }

  // Every look is its own fish: base coat, fin and tail tints, the pattern it
  // is known for, and a build. A kohaku is not a showa in other colours.
  const KOI_DESIGNS = {
    kohaku: {
      base: ["#f8f3e8", "#eee4d0"], belly: "#fffcf2", fin: "#f5e2d2", tail: "#f6ecdc",
      kind: "saddles", saddle: ["#d33f1c", "#c23318", "#e2542a"], saddles: [2, 3],
    },
    sanke: {
      base: ["#f8f3e8", "#eee4d0"], belly: "#fffcf2", fin: "#f1e6d6", tail: "#f6ecdc",
      kind: "saddles", saddle: ["#d33f1c", "#c93a1c"], saddles: [2, 3],
      sumi: ["#1b1b24", "#26262f"], spots: [3, 6],
    },
    showa: {
      base: ["#1e1e29", "#141419"], belly: "#2c2c38", fin: "#e9ded0", tail: "#2a2a35",
      kind: "showa", saddle: ["#d33f1c", "#e04a20"], saddles: [2, 3],
      white: ["#f2ecdc", "#e8e0cc"], whites: [1, 2],
    },
    utsuri: {
      base: ["#1e1e29", "#141419"], belly: "#2c2c38", fin: "#e6dfd0", tail: "#2a2a35",
      kind: "utsuri", white: ["#f2ecdc", "#e4dbc4"], whites: [2, 3],
    },
    bekko: {
      base: ["#f3edd9", "#e9dfc0"], belly: "#fdf7e6", fin: "#efe7d0", tail: "#f2ead6",
      kind: "bekko", sumi: ["#18181f", "#23232c"], spots: [7, 11],
    },
    tancho: {
      base: ["#f9f4ec", "#f0ead9"], belly: "#fffdf6", fin: "#f5ebda", tail: "#f8f1e4",
      kind: "tancho", crown: ["#d33f1c", "#c23318"],
    },
    ogon: {
      base: ["#e9b845", "#d3a02c"], belly: "#f4d078", fin: "#eabf52", tail: "#e8bd4e",
      kind: "plain", sheen: "#ffe9a4", net: 0.24, ridge: "#b8891f",
    },
    platinum: {
      base: ["#eef0ee", "#dde3e1"], belly: "#ffffff", fin: "#e6ecea", tail: "#eaf0ee",
      kind: "plain", sheen: "#ffffff", net: 0.18, ridge: "#bfc9c5",
    },
    asagi: {
      base: ["#8197aa", "#6d8397"], belly: "#c6d2da", fin: "#d8763a", tail: "#93a6b6",
      kind: "asagi", edge: ["#d8763a", "#c4642c"], head: "#a9b8c2", net: 1.0,
    },
    chagoi: {
      base: ["#9d7c46", "#87663a"], belly: "#c4a473", fin: "#ae8a4d", tail: "#a5834b",
      kind: "plain", net: 0.72, ridge: "#795b2f",
    },
  };

  // One wrap band across the back: rounded shoulders, ragged ends, solid
  // middle. This is how a kohaku's red actually sits on the body.
  function saddleBand(ctx, rand, geo, x0, x1, color) {
    const { spineRow, bodyLen, maxHalf, inBody } = geo;
    const left = clamp(x0, 0, bodyLen - 1);
    const right = clamp(x1, 1, bodyLen - 1);
    for (let x = Math.floor(left); x <= Math.ceil(right); x++) {
      const p = (x - left) / Math.max(1, right - left);
      if (p < 0 || p > 1) continue;
      const t = x / Math.max(1, bodyLen - 1);
      const hw = maxHalf * bodyHalfAt(t);
      // a rounded belly to the band, with stepped shoulders so the ends are
      // never a straight vertical cut
      let shape = Math.pow(Math.sin(Math.PI * clamp(p, 0, 1)), 0.6);
      if (p < 0.22 || p > 0.78) shape -= rand.range(0, 0.28);
      const half = hw * clamp(shape * (0.97 + rand.range(-0.04, 0.04)), 0, 1);
      for (let y = Math.round(spineRow - half); y <= Math.round(spineRow + half); y++) {
        if (!inBody(x, y)) continue;
        const edge = Math.abs(y - spineRow) > half - 1 ? 0.87 : 1;
        px(ctx, x, y, rgbToHex(shadeRgb(hexToRgb(color), edge * (1 + rand.range(-0.03, 0.03)))));
      }
    }
  }

  function sumiSpot(ctx, rand, geo, x, y, r, color) {
    const { inBody } = geo;
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        const d = Math.hypot(dx, dy * 1.25);
        if (d > r * (0.82 + rand.range(-0.2, 0.2))) continue;
        const pxx = Math.round(x + dx);
        const pyy = Math.round(y + dy);
        if (!inBody(pxx, pyy)) continue;
        px(ctx, pxx, pyy, rgbToHex(shadeRgb(hexToRgb(color), 1 + rand.range(-0.06, 0.06))));
      }
    }
  }

  // A koi lying nose-left, seen from straight above. Returns the canvas plus
  // the silhouette table the bend mesh rides on.
  function paintKoi(rand, varietyName, length) {
    const design = KOI_DESIGNS[varietyName] || KOI_DESIGNS.kohaku;
    const L = Math.round(length);
    // body half-width from the length (a top-view koi wants length/width
    // around 5), then room above and below for the fins and the tail fan
    const maxHalf = Math.max(2, Math.round(L * 0.115));
    const H = maxHalf * 2 + 6;
    const { c, ctx } = makeCanvas(L, H);
    const spineRow = Math.floor(H / 2);
    const bodyLen = Math.round(L * 0.72);
    const base0 = hexToRgb(design.base[0]);
    const base1 = hexToRgb(design.base[1]);
    const belly = hexToRgb(design.belly);
    const dark = rgbToHex(shadeRgb(mixRgb(base0, [18, 16, 20], 0.6), 0.92));
    const geo = { L, H, spineRow, bodyLen, maxHalf };
    const inBody = (x, y) => {
      if (x < 0 || x >= bodyLen) return false;
      const t = x / Math.max(1, bodyLen - 1);
      const hw = maxHalf * bodyHalfAt(t);
      return Math.abs(y - spineRow) <= hw;
    };
    geo.inBody = inBody;

    // --- base coat: head to tail gradient, a touch of jitter per column ---
    for (let x = 0; x < bodyLen; x++) {
      const t = x / Math.max(1, bodyLen - 1);
      const hw = Math.max(1, Math.round(maxHalf * bodyHalfAt(t)));
      const col = rgbToHex(mixRgb(base0, base1, t * 0.85 + rand.range(-0.02, 0.02)));
      solid(ctx, x, spineRow - hw, 1, hw * 2 + 1, col);
    }

    // --- the pattern this variety is known for ---
    if (design.kind === "saddles") {
      // kohaku and sanke: two or three bold red wraps with clean shoulders
      const count = rand.int(design.saddles[0], design.saddles[1]);
      for (let i = 0; i < count; i++) {
        const slot = 0.2 + (i + rand.range(0.15, 0.65)) * (0.68 / count);
        const cx = bodyLen * slot;
        const w = bodyLen * rand.range(0.13, 0.2);
        const color = rand.pick(design.saddle);
        saddleBand(ctx, rand, geo, cx - w * 0.5, cx + w * 0.5, color);
        if (rand.chance(0.6)) {
          const sx = cx + w * rand.range(0.5, 0.9) * rand.sign();
          saddleBand(ctx, rand, geo, sx - w * 0.16, sx + w * 0.16, color);
        }
      }
      if (design.sumi) {
        const spots = rand.int(design.spots[0], design.spots[1]);
        for (let i = 0; i < spots; i++) {
          const cx = bodyLen * rand.range(0.16, 0.92);
          const t = cx / Math.max(1, bodyLen - 1);
          const hw = maxHalf * bodyHalfAt(t);
          sumiSpot(ctx, rand, geo, cx, spineRow + rand.range(-hw * 0.85, hw * 0.85),
            rand.range(0.7, 1.5), rand.pick(design.sumi));
        }
      }
    } else if (design.kind === "showa") {
      // black fish: red wraps, then white patches on head, flank and tail
      const reds = rand.int(design.saddles[0], design.saddles[1]);
      for (let i = 0; i < reds; i++) {
        const cx = bodyLen * rand.range(0.24, 0.86);
        const w = bodyLen * rand.range(0.12, 0.2);
        saddleBand(ctx, rand, geo, cx - w * 0.5, cx + w * 0.5, rand.pick(design.saddle));
      }
      const whites = rand.int(design.whites[0], design.whites[1]);
      for (let i = 0; i < whites; i++) {
        const cx = i === 0 ? bodyLen * rand.range(0.12, 0.22) : bodyLen * rand.range(0.3, 0.9);
        const w = bodyLen * (i === 0 ? rand.range(0.06, 0.1) : rand.range(0.1, 0.17));
        saddleBand(ctx, rand, geo, cx - w * 0.5, cx + w * 0.5, rand.pick(design.white));
      }
    } else if (design.kind === "utsuri") {
      // shiro utsuri: white only, no red anywhere
      const whites = rand.int(design.whites[0], design.whites[1]);
      for (let i = 0; i < whites; i++) {
        const cx = i === 0 ? bodyLen * rand.range(0.14, 0.3) : bodyLen * rand.range(0.36, 0.88);
        const w = bodyLen * (i === 0 ? rand.range(0.07, 0.12) : rand.range(0.11, 0.19));
        saddleBand(ctx, rand, geo, cx - w * 0.5, cx + w * 0.5, rand.pick(design.white));
      }
    } else if (design.kind === "bekko") {
      // cream fish, scattered black spots of two sizes
      const spots = rand.int(design.spots[0], design.spots[1]);
      for (let i = 0; i < spots; i++) {
        const cx = bodyLen * rand.range(0.14, 0.94);
        const t = cx / Math.max(1, bodyLen - 1);
        const hw = maxHalf * bodyHalfAt(t);
        const big = rand.chance(0.45);
        sumiSpot(ctx, rand, geo, cx, spineRow + rand.range(-hw * 0.8, hw * 0.8),
          big ? rand.range(1.2, 1.9) : rand.range(0.6, 1.0), rand.pick(design.sumi));
      }
    } else if (design.kind === "tancho") {
      // the prized one: a single clean crown between the eyes
      const cx = bodyLen * 0.19;
      const hw = maxHalf * bodyHalfAt(cx / Math.max(1, bodyLen - 1));
      const rx = Math.max(2, bodyLen * 0.088);
      const ry = Math.max(2, hw * 0.88);
      const crownCol = rand.pick(design.crown);
      for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
        for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
          if (Math.hypot(dx / rx, dy / ry) > 1) continue;
          const x = Math.round(cx + dx);
          const y = Math.round(spineRow + dy);
          if (!inBody(x, y)) continue;
          px(ctx, x, y, rgbToHex(shadeRgb(hexToRgb(crownCol), Math.hypot(dx / rx, dy / ry) > 0.86 ? 0.9 : 1)));
        }
      }
    } else if (design.kind === "asagi") {
      // blue-grey back in a bold scale net, orange marks along the flanks,
      // and a paler head: the blue net is the whole point of an asagi
      const netA = hexToRgb(design.base[0]);
      const netB = shadeRgb(hexToRgb(design.base[1]), 1.18);
      const headRgb = hexToRgb(design.head);
      for (let x = 0; x < bodyLen; x++) {
        const t = x / Math.max(1, bodyLen - 1);
        const hw = Math.max(1, Math.round(maxHalf * bodyHalfAt(t)));
        const headAmt = 1 - smoothstep(0.18, 0.34, t);
        for (let y = spineRow - hw; y <= spineRow + hw; y++) {
          const cell = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0;
          let col = mixRgb(netA, netB, cell ? 0.85 : 0.15);
          col = shadeRgb(col, 1 + (valueNoise2(x * 0.7, y * 0.7) - 0.5) * 0.1);
          if (headAmt > 0) col = mixRgb(col, headRgb, headAmt * 0.8);
          px(ctx, x, y, rgbToHex(col));
        }
      }
      const marks = rand.int(3, 5);
      for (let i = 0; i < marks; i++) {
        const cx = Math.round(bodyLen * rand.range(0.3, 0.9));
        const side = rand.sign();
        const t = cx / Math.max(1, bodyLen - 1);
        const hw = maxHalf * bodyHalfAt(t);
        const len = rand.int(2, 4);
        const col = rgbToHex(shadeRgb(hexToRgb(rand.pick(design.edge)), 1 + rand.range(-0.05, 0.05)));
        for (let k = 0; k < len; k++) {
          const y = spineRow + side * Math.round(hw * rand.range(0.7, 0.95));
          px(ctx, cx + k, y, col);
        }
      }
    }

    // --- scale net (chagoi, ogon, platinum) ---
    if (design.net && design.kind !== "asagi") {
      const netCol = rgbToHex(shadeRgb(base0, 0.9));
      const netLight = rgbToHex(shadeRgb(base0, 1.05));
      for (let x = 2; x < bodyLen - 1; x += 2) {
        const t = x / Math.max(1, bodyLen - 1);
        const hw = maxHalf * bodyHalfAt(t);
        for (let y = Math.round(spineRow - hw) + 1; y <= Math.round(spineRow + hw) - 1; y++) {
          if (!inBody(x, y)) continue;
          const cell = (Math.floor(x / 2) + Math.floor(y)) % 2 === 0;
          if (cell && rand.chance(design.net * 0.5)) px(ctx, x, y, netCol);
          else if (!cell && rand.chance(design.net * 0.25)) px(ctx, x, y, netLight);
        }
      }
    }

    // --- dorsal ridge: a thin line down the back half ---
    const ridgeCol = rgbToHex(design.ridge
      ? hexToRgb(design.ridge)
      : shadeRgb(base0, base0[0] + base0[1] + base0[2] < 300 ? 1.6 : 0.88));
    for (let x = Math.round(bodyLen * 0.5); x < bodyLen; x++) px(ctx, x, spineRow, ridgeCol);

    // --- sheen and lateral shading, in one pass over the pixels ---
    // the back catches the light, the flanks fall away, and the very edge
    // picks up the pale belly: this is what makes the body read as round
    const img = ctx.getImageData(0, 0, L, H);
    const data = img.data;
    const sheenRgb = design.sheen ? hexToRgb(design.sheen) : null;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < bodyLen; x++) {
        const t = x / Math.max(1, bodyLen - 1);
        const hw = maxHalf * bodyHalfAt(t);
        const rel = Math.abs(y - spineRow) / Math.max(1, hw);
        if (rel > 1) continue;
        const o = (y * L + x) * 4;
        if (data[o + 3] === 0) continue;
        let col = [data[o], data[o + 1], data[o + 2]];
        if (sheenRgb) {
          const band = Math.max(1, hw * 0.62);
          const dy = Math.abs(y - spineRow);
          if (dy <= band) col = mixRgb(col, sheenRgb, (1 - dy / band) * 0.5);
        }
        col = shadeRgb(col, 1 + 0.06 * (1 - rel) - 0.2 * Math.pow(rel, 1.5));
        if (rel > 0.86) col = mixRgb(col, belly, 0.3);
        data[o] = col[0];
        data[o + 1] = col[1];
        data[o + 2] = col[2];
      }
    }
    ctx.putImageData(img, 0, 0);

    // --- pectoral fins: short lobes at the gills, swept back ---
    const finRgb = hexToRgb(design.fin);
    const gx = Math.round(bodyLen * 0.27);
    for (const side of [-1, 1]) {
      const t = gx / Math.max(1, bodyLen - 1);
      const hw = maxHalf * bodyHalfAt(t);
      const reach = Math.max(2, Math.round(hw * rand.range(0.45, 0.65)));
      for (let i = 0; i < reach; i++) {
        const y = Math.round(spineRow + side * (hw + i));
        if (y < 1 || y >= H) break;
        const wid = Math.max(1, Math.round(reach * 0.6 - i * 0.4));
        const col = rgbToHex(shadeRgb(finRgb, 1 - i / (reach * 3.2)));
        for (let k = 0; k < wid; k++) px(ctx, gx + i - k, y, col);
      }
    }

    // --- tail fan: two translucent lobes with the fork between them ---
    const tailBase = hexToRgb(design.tail);
    const rootHalf = Math.max(1.2, maxHalf * 0.34);
    const tailSpan = Math.max(2, L - 1 - bodyLen);
    for (let x = bodyLen; x < L; x++) {
      const p = clamp((x - bodyLen) / tailSpan, 0, 1);
      const half = rootHalf + (maxHalf * 1.15 - rootHalf) * Math.pow(p, 0.7);
      // the notch runs from the peduncle all the way out: two lobes, not a paddle
      const inner = rootHalf * 0.3 + half * Math.pow(p, 1.1) * 0.62;
      for (const side of [-1, 1]) {
        for (let y = Math.round(inner); y <= Math.round(half); y++) {
          const yy = Math.round(spineRow + side * y);
          if (yy < 0 || yy >= H) continue;
          const rel = (y - inner) / Math.max(0.5, half - inner);
          const col = mixRgb(tailBase, belly, 0.22 + (1 - rel) * 0.45);
          px(ctx, x, yy, rgbToHex(shadeRgb(col, 1 - 0.1 * (1 - rel))));
        }
      }
    }
    // rays on the lobes, and a hint of the peduncle's shadow
    for (const ray of [0.32, 0.6, 0.86]) {
      const x = bodyLen + Math.round(ray * tailSpan);
      const half = rootHalf + (maxHalf * 1.15 - rootHalf) * Math.pow(ray, 0.7);
      const rayCol = rgbToHex(shadeRgb(tailBase, 0.84));
      for (const side of [-1, 1]) {
        const yy = Math.round(spineRow + side * half * 0.82);
        if (yy > 0 && yy < H) px(ctx, x, yy, rayCol);
      }
    }

    // --- face: eyes, and a mouth notch at the snout ---
    const eyeX = Math.max(1, Math.round(bodyLen * 0.1));
    const eyeHalf = Math.max(1, Math.round(maxHalf * bodyHalfAt(eyeX / Math.max(1, bodyLen - 1)) * 0.62));
    const darkFish = base0[0] + base0[1] + base0[2] < 300;
    for (const side of [-1, 1]) {
      const y = spineRow + side * eyeHalf;
      if (darkFish) {
        px(ctx, eyeX - 1, y, "#c9cec9");
        px(ctx, eyeX, y, "#101018");
      } else {
        px(ctx, eyeX, y, "#1a1a20");
      }
    }
    const mouthCol = rgbToHex(shadeRgb(base0, 0.72));
    for (const side of [-1, 0, 1]) px(ctx, 0, spineRow + side, mouthCol);

    outline(c, dark, 40);
    harden(c);
    return { canvas: c, extents: measureExtents(c, spineRow), length: L, height: H, spineRow, variety: varietyName };
  }


  // ------------------------------------------------------------- minnow

  const MINNOW_VARIANTS = {
    silver: { back: "#b9c2c8", belly: "#e8eef0", tail: "#a7b2ba" },
    slate: { back: "#6f8496", belly: "#c2cfd8", tail: "#5d7284" },
    gold: { back: "#d8a648", belly: "#f0d792", tail: "#c2903a" },
    ember: { back: "#cf6a3d", belly: "#f0b98a", tail: "#b4552f" },
  };

  function paintMinnow(rand, variant) {
    const v = MINNOW_VARIANTS[variant] || MINNOW_VARIANTS.silver;
    const L = 10;
    const H = 6;
    const { c, ctx } = makeCanvas(L, H);
    const spineRow = Math.floor(H / 2);
    const bodyLen = 7;
    const back = hexToRgb(v.back);
    const belly = hexToRgb(v.belly);
    for (let x = 0; x < bodyLen; x++) {
      const t = x / (bodyLen - 1);
      const half = Math.max(0, Math.round((1.7 - Math.abs(t - 0.42) * 1.9) * 1.0 + 0.4));
      if (half <= 0) continue;
      for (let y = -half; y <= half; y++) {
        const y0 = spineRow + y;
        if (y0 < 0 || y0 >= H) continue;
        px(ctx, x, y0, rgbToHex(mixRgb(back, belly, clamp(0.5 + y / (half * 2 + 0.001), 0, 1))));
      }
    }
    // tail + a soft rim tinted from the back colour (dark rims read as bones
    // once small fish overlap)
    const rim = rgbToHex(shadeRgb(back, 0.72));
    px(ctx, bodyLen, spineRow, v.tail);
    px(ctx, bodyLen + 1, spineRow - 1, rim);
    px(ctx, bodyLen + 1, spineRow + 1, rim);
    px(ctx, bodyLen + 1, spineRow, v.tail);
    px(ctx, bodyLen + 2, spineRow, rim);
    px(ctx, 1, spineRow, rim);
    px(ctx, 1, spineRow - 1, rim);
    px(ctx, 1, spineRow + 1, rim);
    px(ctx, bodyLen, spineRow - 2, rim);
    px(ctx, bodyLen, spineRow + 2, rim);
    px(ctx, 2, spineRow - 2, rim);
    px(ctx, 2, spineRow + 2, rim);
    // eye
    px(ctx, 1, spineRow - 1, "#12141a");
    harden(c);
    return { canvas: c, extents: measureExtents(c, spineRow), length: L, height: H, spineRow };
  }

  // ----------------------------------------------------------- butterflies

  // three wing spreads, so flapping is a frame swap on one sprite
  function paintButterfly(rand, palette, spread) {
    const W = 15;
    const H = 11;
    const { c, ctx } = makeCanvas(W, H);
    const cx = Math.floor(W / 2);
    const cy = Math.floor(H / 2);
    const wing = hexToRgb(palette.wing);
    const light = hexToRgb(palette.wingLight);
    const accent = hexToRgb(palette.accent);
    const body = hexToRgb(palette.body);
    const span = Math.max(1, Math.round(2 + spread * 4.4));
    for (const side of [-1, 1]) {
      for (let i = 1; i <= span; i++) {
        const t = i / span;
        const hh = Math.max(1, Math.round((2.6 - t * 0.7) * (1 - spread * 0.25)));
        const x = cx + side * i;
        for (let y = -hh; y <= hh; y++) {
          const col = t > 0.72 ? rgbToHex(mixRgb(wing, [0, 0, 0], 0.25)) : i <= 2 ? rgbToHex(light) : rgbToHex(wing);
          px(ctx, x, cy + y, col);
        }
        if (i >= 2 && i <= 3) {
          for (let y = -hh; y <= hh; y += 2) {
            px(ctx, x, cy + y, rgbToHex(mixRgb(accent, wing, 0.35)));
          }
        }
      }
    }
    solid(ctx, cx, cy - 2, 1, 5, rgbToHex(body));
    px(ctx, cx - 1, cy + 1, rgbToHex(shadeRgb(body, 0.8)));
    px(ctx, cx + 1, cy + 1, rgbToHex(shadeRgb(body, 0.8)));
    px(ctx, cx, cy - 3, rgbToHex(shadeRgb(body, 1.2)));
    if (spread > 0.5) {
      px(ctx, cx - 2, cy - 3, rgbToHex(shadeRgb(body, 1.1)));
      px(ctx, cx + 2, cy - 3, rgbToHex(shadeRgb(body, 1.1)));
    }
    harden(c);
    return c;
  }

  // wings folded, sitting on a flower
  function paintButterflyRest(rand, palette) {
    const W = 7;
    const H = 8;
    const { c, ctx } = makeCanvas(W, H);
    const wing = hexToRgb(palette.wing);
    const body = hexToRgb(palette.body);
    const accent = hexToRgb(palette.accent);
    solid(ctx, 3, 2, 1, 5, rgbToHex(body));
    for (let y = 2; y < 7; y++) {
      const w = y === 6 ? 1 : 2;
      px(ctx, 3 - w, y, rgbToHex(y > 4 ? shadeRgb(wing, 0.8) : wing));
      px(ctx, 3 + w, y, rgbToHex(y > 4 ? shadeRgb(wing, 0.8) : wing));
    }
    px(ctx, 2, 3, rgbToHex(accent));
    px(ctx, 4, 3, rgbToHex(accent));
    px(ctx, 3, 1, rgbToHex(shadeRgb(body, 1.2)));
    harden(c);
    return c;
  }

  // ----------------------------------------------------------- plants etc

  // A water-lily pad from above: a clean disc with one crisp wedge cut to the
  // centre, a raised rim, radiating veins, and a sheen where the sun hits it.
  function paintLilyPad(rand, size) {
    const S = Math.round(size);
    const { c, ctx } = makeCanvas(S, S);
    const cx = S / 2 - 0.5;
    const cy = S / 2 - 0.5;
    const r = S / 2 - 1;
    const green = [86, 126, 56];
    const light = [118, 158, 76];
    const dark = [54, 86, 40];
    const rimCol = [42, 72, 32];
    const notchAngle = rand.range(-0.7, 0.7);
    const notchHalf = rand.range(0.16, 0.26); // half-angle of the wedge cut
    const hueShift = rand.range(-0.05, 0.05);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.hypot(dx, dy);
        if (d > r + 0.5) continue;
        const a = Math.atan2(dy, dx);
        if (Math.abs(wrapAngle(a - notchAngle)) < notchHalf) continue;
        const edge = r * (0.985 + (valueNoise2(Math.cos(a) * 2.6 + 17, Math.sin(a) * 2.6 + 4) - 0.5) * 0.05);
        if (d > edge) continue;
        const t = d / Math.max(1, edge);
        let col = mixRgb(light, green, smoothstep(0.15, 0.8, t));
        col = mixRgb(col, dark, smoothstep(0.82, 1.0, t) * 0.62);
        if (t > 0.9) col = mixRgb(col, rimCol, 0.6);
        // sun from the upper left
        const sunDot = (dx * -0.5 + dy * -0.78) / Math.max(1, d);
        col = shadeRgb(col, 1 + Math.max(0, sunDot) * 0.07 * (1 - t * 0.45));
        col = shadeRgb(col, 1 + (valueNoise2(x * 0.35, y * 0.35) - 0.5) * 0.06);
        col = shadeRgb(col, 1 + hueShift);
        px(ctx, x, y, rgbToHex(col));
      }
    }
    // veins: thin, faint, and they stop short of the centre so the leaf stays
    // a leaf and not a cartwheel
    const veins = rand.int(6, 9);
    const veinCol = rgbToHex(shadeRgb(green, 0.87));
    for (let i = 0; i < veins; i++) {
      const a0 = notchAngle + notchHalf + 0.14 + (i / veins) * (TAU - notchHalf * 2 - 0.28);
      for (let d = r * 0.24; d < r * 0.84; d += 1) {
        const fade = smoothstep(0.24, 0.42, d / r) * (1 - smoothstep(0.72, 0.86, d / r));
        if (fade < 0.35) continue;
        const bend = Math.sin(d * 0.45 + i * 1.7) * 0.05;
        const x = Math.round(cx + Math.cos(a0 + bend) * d);
        const y = Math.round(cy + Math.sin(a0 + bend) * d);
        px(ctx, x, y, veinCol);
      }
    }
    // where the stem meets the leaf
    ellipse(ctx, cx, cy, Math.max(1, r * 0.14), Math.max(1, r * 0.14), rgbToHex(shadeRgb(dark, 0.8)));
    px(ctx, Math.round(cx), Math.round(cy), rgbToHex(shadeRgb(light, 1.06)));
    harden(c);
    return c;
  }

  // A lotus flower: an outer ring of petals, an inner ring, a ring of stamens
  // and a tight core. Outlined, because it has to hold up against a green pad.
  function paintLotusFlower(rand, colorway, size) {
    const S = Math.round(size);
    const { c, ctx } = makeCanvas(S, S);
    const cx = S / 2;
    const cy = S / 2;
    const palettes = {
      pink: { outer: ["#e07f9f", "#c95c82"], inner: ["#f6b8cd", "#f0a2bd"] },
      white: { outer: ["#e8e2d2", "#cfc8b4"], inner: ["#ffffff", "#f7f3e8"] },
      red: { outer: ["#d0435c", "#b62c45"], inner: ["#ea7086", "#dd5a70"] },
    };
    const pal = palettes[colorway] || palettes.pink;
    const outer = pal.outer.map(hexToRgb);
    const inner = pal.inner.map(hexToRgb);

    const petals = 6;
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * TAU + rand.range(-0.08, 0.08);
      const len = S * rand.range(0.34, 0.42);
      const wid = S * rand.range(0.085, 0.11);
      ellipse(ctx, cx + Math.cos(a) * len * 0.52, cy + Math.sin(a) * len * 0.52, wid, len * 0.56, rgbToHex(outer[i % 2]));
    }
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + TAU / 10 + rand.range(-0.06, 0.06);
      const len = S * rand.range(0.2, 0.26);
      const wid = S * rand.range(0.07, 0.09);
      ellipse(ctx, cx + Math.cos(a) * len * 0.5, cy + Math.sin(a) * len * 0.5, wid, len * 0.56, rgbToHex(inner[i % 2]));
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.3;
      px(ctx, Math.round(cx + Math.cos(a) * S * 0.08), Math.round(cy + Math.sin(a) * S * 0.08), "#f2d45c");
    }
    ellipse(ctx, cx, cy, Math.max(1, S * 0.06), Math.max(1, S * 0.06), "#cfa22c");
    outline(c, rgbToHex(shadeRgb(outer[1], 0.78)), 40);
    harden(c);
    return c;
  }


  function paintMossClump(rand, colors) {
    const W = 13;
    const H = 9;
    const { c, ctx } = makeCanvas(W, H);
    const c0 = hexToRgb(colors[0]);
    const c1 = hexToRgb(colors[1]);
    for (let i = 0; i < 26; i++) {
      const x = Math.round(rand.range(1, W - 2));
      const y = Math.round(rand.range(1, H - 2));
      const r = rand.range(1.2, 2.6);
      ellipse(ctx, x, y, r, r * 0.8, rgbToHex(mixRgb(c0, c1, rand.unit())));
    }
    for (let x = 1; x < W - 1; x++) {
      if (rand.chance(0.72)) px(ctx, x, H - 2, rgbToHex(shadeRgb(c1, 0.72)));
    }
    for (let i = 0; i < 5; i++) {
      const x = Math.round(rand.range(2, W - 3));
      const h = rand.int(2, 4);
      for (let k = 0; k < h; k++) px(ctx, x, H - 3 - k, rgbToHex(shadeRgb(c0, 1.14)));
    }
    harden(c);
    return c;
  }

  function paintStone(rand) {
    const W = 16;
    const H = 11;
    const { c, ctx } = makeCanvas(W, H);
    const base = hexToRgb("#8d8779");
    const cx = W / 2;
    const cy = H / 2 + 0.5;
    const rx = rand.range(5.5, 7);
    const ry = rand.range(3.6, 4.6);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const qx = (x - cx) / rx;
        const qy = (y - cy) / ry;
        const d = Math.hypot(qx, qy) * (0.86 + valueNoise2(x * 0.5 + 7, y * 0.5) * 0.28);
        if (d > 1) continue;
        let col = mixRgb(shadeRgb(base, 1.12), shadeRgb(base, 0.78), smoothstep(0.15, 1, d));
        col = shadeRgb(col, 1 + (valueNoise2(x * 0.6, y * 0.6 + 12) - 0.5) * 0.16);
        if (y > cy + ry * 0.4) col = shadeRgb(col, 0.86);
        px(ctx, x, y, rgbToHex(col));
      }
    }
    for (let i = 0; i < 4; i++) {
      px(ctx, Math.round(cx + rand.range(-rx * 0.5, rx * 0.5)), Math.round(cy - ry * 0.55), rgbToHex(shadeRgb(base, 1.28)));
    }
    harden(c);
    return c;
  }

  function paintGrassTuft(rand, colors) {
    const W = 11;
    const H = 9;
    const { c, ctx } = makeCanvas(W, H);
    const c0 = hexToRgb(colors[0]);
    const c1 = hexToRgb(colors[1]);
    const blades = rand.int(5, 8);
    for (let i = 0; i < blades; i++) {
      const x = Math.round(rand.range(1, W - 2));
      const h = rand.int(3, H - 2);
      const bend = rand.range(-1.4, 1.4);
      const col = rgbToHex(mixRgb(c0, c1, rand.unit()));
      for (let k = 0; k < h; k++) {
        const t = k / h;
        const bx = Math.round(x + bend * t * t);
        px(ctx, bx, H - 1 - k, k > h - 2 ? rgbToHex(shadeRgb(hexToRgb(col), 1.15)) : col);
      }
    }
    harden(c);
    return c;
  }

  function paintReedClump(rand) {
    const W = 13;
    const H = 16;
    const { c, ctx } = makeCanvas(W, H);
    const stalk = "#6d8a44";
    const stalk2 = "#556e34";
    const head = "#8a6b3a";
    const reeds = rand.int(3, 4);
    for (let i = 0; i < reeds; i++) {
      const x = Math.round(rand.range(2, W - 3));
      const h = rand.int(9, H - 3);
      const bend = rand.range(-0.9, 0.9);
      for (let k = 0; k < h; k++) {
        const t = k / h;
        const bx = Math.round(x + bend * t * t * 2);
        px(ctx, bx, H - 1 - k, rand.chance(0.5) ? stalk : stalk2);
      }
      const hx = Math.round(x + bend * 2);
      px(ctx, hx, H - 1 - h, head);
      px(ctx, hx, H - h, head);
      px(ctx, hx + 1, H - 1 - h, rgbToHex(shadeRgb(hexToRgb(head), 0.85)));
    }
    harden(c);
    return c;
  }

  function paintShoreFlower(rand, colorway) {
    const W = 7;
    const H = 10;
    const { c, ctx } = makeCanvas(W, H);
    const cols = {
      white: "#f4f0e2", yellow: "#f2d45c", blue: "#7c9fd4", pink: "#eda4bd",
    }[colorway] || "#f4f0e2";
    const c0 = hexToRgb(cols);
    const stem = "#5d7a3c";
    const x0 = 3;
    const h = rand.int(4, 6);
    for (let k = 0; k < h; k++) px(ctx, x0, H - 1 - k, stem);
    const cy = H - 1 - h - 1;
    ellipse(ctx, x0, cy, 2.2, 2.0, rgbToHex(c0));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      px(ctx, Math.round(x0 + Math.cos(a) * 2.2), Math.round(cy + Math.sin(a) * 2.0), rgbToHex(shadeRgb(c0, 1.08)));
    }
    px(ctx, x0, cy, "#e8b93c");
    if (rand.chance(0.5)) px(ctx, x0 - 1, H - 2 - h, rgbToHex(shadeRgb(hexToRgb(stem), 1.1)));
    harden(c);
    return c;
  }

  // a clump of tall underwater weed, seen through the water from above
  function paintPondWeed(rand) {
    const W = 14;
    const H = 26;
    const { c, ctx } = makeCanvas(W, H);
    const g0 = hexToRgb("#3f6b3a");
    const g1 = hexToRgb("#54803f");
    const strands = rand.int(4, 7);
    for (let i = 0; i < strands; i++) {
      const x0 = rand.range(2, W - 3);
      const h = rand.range(H * 0.5, H * 0.95);
      const bend = rand.range(-2.2, 2.2);
      const col = rgbToHex(mixRgb(g0, g1, rand.unit()));
      const w = rand.chance(0.35) ? 2 : 1;
      for (let k = 0; k < h; k++) {
        const t = k / h;
        const xx = Math.round(x0 + bend * t * t);
        const yy = Math.round(H - 1 - k);
        for (let ww = 0; ww < w; ww++) px(ctx, xx + ww, yy, col);
      }
      if (rand.chance(0.5)) {
        const t = rand.range(0.3, 0.7);
        const xx = Math.round(x0 + bend * t * t);
        const yy = Math.round(H - 1 - h * t);
        px(ctx, xx - 1, yy, rgbToHex(mixRgb(hexToRgb(col), [235, 245, 235], 0.18)));
        px(ctx, xx + 1, yy, rgbToHex(mixRgb(hexToRgb(col), [235, 245, 235], 0.18)));
      }
    }
    harden(c);
    return c;
  }

  // a flat mat of moss lying on the water: rounded outline, a wet dark
  // underside rim, a few holes where water shows through, bright sprigs on top
  function paintFloatingMoss(rand) {
    const W = 13;
    const H = 10;
    const { c, ctx } = makeCanvas(W, H);
    const dark = hexToRgb("#2f4d24");
    const mid = hexToRgb("#3f6b2c");
    const light = hexToRgb("#548b38");
    const bright = hexToRgb("#6fa446");
    const rx = W * 0.44;
    const ry = H * 0.4;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const qx = (x - (W - 1) / 2) / rx;
        const qy = (y - (H - 1) / 2) / ry;
        const wob = 0.82 + valueNoise2(x * 0.9 + 11.3, y * 0.9 + 4.7) * 0.42;
        const dist = Math.hypot(qx, qy);
        if (dist > wob) continue;
        let col = mid;
        if (dist > wob * 0.78) col = dark;
        else if (dist < wob * 0.45) col = light;
        px(ctx, x, y, rgbToHex(col));
      }
    }
    // bright sprigs and a couple of holes
    const sprigs = rand.int(2, 5);
    for (let i = 0; i < sprigs; i++) {
      const x = rand.int(3, W - 4);
      const y = rand.int(2, H - 3);
      px(ctx, x, y, rgbToHex(bright));
      if (rand.chance(0.6)) px(ctx, x + 1, y - 1, rgbToHex(mixRgb(bright, light, 0.4)));
    }
    for (let i = 0, n = rand.int(1, 3); i < n; i++) {
      const x = rand.int(3, W - 4);
      const y = rand.int(2, H - 3);
      px(ctx, x, y, rgbToHex(mixRgb(mid, [70, 110, 96], 0.55)));
    }
    harden(c);
    return c;
  }

  function paintDuckweed(rand) {
    const W = 5;
    const H = 4;
    const { c, ctx } = makeCanvas(W, H);
    const g = hexToRgb("#6da03c");
    for (let i = 0; i < 3; i++) {
      const x = Math.round(rand.range(1, W - 2));
      const y = Math.round(rand.range(1, H - 2));
      px(ctx, x, y, rgbToHex(shadeRgb(g, rand.range(0.9, 1.15))));
    }
    px(ctx, Math.round(rand.range(1, W - 2)), Math.round(rand.range(1, H - 2)), rgbToHex(shadeRgb(g, 1.2)));
    harden(c);
    return c;
  }

  // soft dark blob used for shadows; painted white, tinted at draw time
  function paintBlob() {
    const S = 32;
    const { c, ctx } = makeCanvas(S, S);
    const r = S / 2 - 1;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = Math.hypot(x - S / 2 + 0.5, y - S / 2 + 0.5) / r;
        if (d > 1) continue;
        // dithered edge so the shadow keeps to the pixel grid
        const a = d < 0.72 ? 1 : (valueNoise2(x * 1.7, y * 1.7) + (1 - d) * 6 > 1 ? 1 : 0);
        if (a > 0) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    harden(c);
    return c;
  }

  return {
    makeCanvas, harden, outline, measureExtents, extentsAt,
    paintKoi, paintMinnow, paintButterfly, paintButterflyRest,
    paintLilyPad, paintLotusFlower, paintMossClump, paintStone,
    paintGrassTuft, paintReedClump, paintShoreFlower, paintDuckweed, paintBlob, paintPondWeed, paintFloatingMoss,
    KOI_DESIGNS, MINNOW_VARIANTS,
  };
})();
