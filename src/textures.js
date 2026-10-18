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
    // the small orange fish: one warm tone with a paler belly, no markings, so
    // at half a koi's length it still reads as a fish and not as a smudge
    orange: {
      base: ["#ef8a2e", "#e0761f"], belly: "#ffd9a4", fin: "#f4a95e", tail: "#ef8f35",
      kind: "saddles", saddle: ["#c9541a", "#b84915"], saddles: [1, 2],
    },
    kohaku: {
      base: ["#f8f3e8", "#eee4d0"], belly: "#fffcf2", fin: "#f5e2d2", tail: "#f6ecdc",
      kind: "saddles", saddle: ["#d33f1c", "#c23318", "#e2542a"], saddles: [2, 3],
    },
    sanke: {
      base: ["#f8f3e8", "#eee4d0"], belly: "#fffcf2", fin: "#f1e6d6", tail: "#f6ecdc",
      kind: "saddles", saddle: ["#d33f1c", "#c93a1c"], saddles: [2, 3],
      sumi: ["#1b1b24", "#26262f"], spots: [8, 13],
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
    shiro: {
      base: ["#fbf8f1", "#f2eee3"], belly: "#ffffff", fin: "#f7f2e7", tail: "#faf6ec",
      kind: "bekko", sumi: ["#14141b", "#1e1e27"], spots: [7, 11],
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
    // Three rows is the floor where a taper and a fork can exist at all. At two
    // the body was a rectangle and the tail root as wide as the flank, which is
    // why the orange fish read as a block with a fan glued on.
    const maxHalf = Math.max(3, Math.round(L * 0.115));
    // A short fish needs a taller fan. At maxHalf 2 the whole tail was five rows
    // deep, so any fork wide enough to see removed the middle of it and left two
    // prongs on a flat wall. Extra spread on the small fish only.
    const tailSpread = maxHalf * 1.32 + (L < 26 ? 0.6 : 0);
    // The tail is two lobes, not a paddle with a notch cut into it. `spread` is
    // how far the outer edge reaches at distance p, `gap` is the half-width of
    // the fork between them, so the lobes are the band in between. Modelling it
    // this way keeps two rows of lobe no matter how short the fish is: the old
    // "erase a band around the spine" approach left a flat wall with prongs.
    const spreadOf = (p) => rootHalf + (tailSpread - rootHalf) * Math.pow(p, 0.68);
    // The gap is a fraction of the fan, not a fixed number of rows: that is what
    // makes the fork the same V at every fish size. It opens from 10% of the
    // fan at the peduncle to 44% at the trailing edge, so the lobes are real
    // fins and the cut is unmistakable.
    const gapOf = (p, spread) => spread * (0.05 + 0.31 * Math.pow(p, 1.3));
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
      const rx = Math.max(2, bodyLen * 0.072);
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

    // --- tail fan ---
    // The root has to be the width the body already is at that point, or the
    // tail meets the body as a wider bar, which reads as a join. From there the
    // fan flares and the fork opens gradually instead of from the first pixel.
    const tailBase = hexToRgb(design.tail);
    let rootHalf = Math.max(1.1, maxHalf * bodyHalfAt(1) * 0.94);
    if (L < 26) rootHalf = Math.max(1, rootHalf * 0.6);
    const tailSpan = Math.max(2, L - 1 - bodyLen + (L < 26 ? 1 : 0));
    const spreadAt = [];
    for (let x = bodyLen; x < L; x++) {
      const p = clamp((x - bodyLen) / tailSpan, 0, 1);
      // the last fifth of the tail rounds off, so the lobes end in a point
      // instead of a square block
      const tip = p > 0.78 ? (p - 0.78) / 0.22 : 0;
      const spread = spreadOf(p) - tip * 0.9;
      const gap = gapOf(p, spread);
      spreadAt[x] = { spread, gap };
      for (let yi = -Math.ceil(spread) - 1; yi <= Math.ceil(spread) + 1; yi++) {
        const ay = Math.abs(yi);
        if (ay < gap) continue;               // inside the fork: open water
        if (ay > spread + 0.3) continue;      // outside the lobe
        const yy = Math.round(spineRow + yi);
        if (yy < 0 || yy >= H) continue;
        const rel = (ay - gap) / Math.max(0.5, spread - gap);
        const col = mixRgb(tailBase, belly, 0.2 + (1 - rel) * 0.42);
        px(ctx, x, yy, rgbToHex(shadeRgb(col, 1 - 0.1 * (1 - rel))));
      }
    }
    // rays down the lobes
    for (const ray of [0.36, 0.66, 0.9]) {
      const x = bodyLen + Math.round(ray * tailSpan);
      const half = spreadOf(ray);
      const gap = gapOf(ray, half);
      const rayCol = rgbToHex(shadeRgb(tailBase, 0.84));
      for (const side of [-1, 1]) {
        const yy = Math.round(spineRow + side * (gap + (half - gap) * 0.55));
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
    // the outline traces the whole silhouette and closes any narrow notch, which
    // turned the fork into a ring. Cut the fork out again, a pixel wider than the
    // art, so the two lobes are genuinely separate at the tip.
    {
      const octx = c.getContext("2d");
      const img = octx.getImageData(0, 0, L, H);
      const px32 = img.data;
      for (let x = bodyLen; x < L; x++) {
        const p = clamp((x - bodyLen) / Math.max(1, L - 1 - bodyLen), 0, 1);
        if (p < 0.42) continue;
        const half = rootHalf + (tailSpread - rootHalf) * Math.pow(p, 0.68);
        const lim = Math.min(half, gapOf(p, half) + 0.6);
        for (let yi = -Math.ceil(lim); yi <= Math.ceil(lim); yi++) {
          if (Math.abs(yi) > lim) continue;
          const yy = Math.round(spineRow + yi);
          if (yy < 0 || yy >= H) continue;
          const i = (yy * L + x) * 4;
          px32[i + 3] = 0;
        }
      }
      octx.putImageData(img, 0, 0);
    }
    harden(c);
    return { canvas: c, extents: measureExtents(c, spineRow), length: L, height: H, spineRow, variety: varietyName };
  }


  // ------------------------------------------------------------- minnow

  // Deep backs against pale bellies. At twelve pixels long the contrast is
  // what makes the fish read; a pale back just dissolves into the water.
  const MINNOW_VARIANTS = {
    silver: { back: "#8d9aa4", belly: "#e6edf0", tail: "#7d8b95" },
    slate: { back: "#4e6376", belly: "#c2cfd8", tail: "#3f5466" },
    gold: { back: "#b07f2c", belly: "#f0d792", tail: "#96702a" },
    ember: { back: "#b04e28", belly: "#f0b98a", tail: "#8e3f20" },
  };
  // A small fish at 13x7: a pointed snout, a shoulder a third of the way back,
  // a straight taper to a thin peduncle, and a fan tail grown straight out of
  // that peduncle. Four tones down the body do the modelling; no outline, so
  // the silhouette stays smooth at this size.
  function paintMinnow(rand, variant) {
    const v = MINNOW_VARIANTS[variant] || MINNOW_VARIANTS.silver;
    const L = 13;
    const H = 7;
    const { c, ctx } = makeCanvas(L, H);
    const spineRow = 3;
    const back = hexToRgb(v.back);
    const belly = hexToRgb(v.belly);
    const tail = hexToRgb(v.tail);
    const dark = shadeRgb(back, 0.78);
    const mid = mixRgb(back, belly, 0.6);
    const fin = mixRgb(tail, belly, 0.12);
    const rim = shadeRgb(tail, 0.8);
    // half height per column: snout, head, a long shoulder, a taper to the
    // peduncle. No fins at this size: a single floating pixel reads as dirt.
    const profile = [0, 1, 2, 2, 2, 2, 2, 1, 1];
    for (let x = 0; x < profile.length; x++) {
      const half = profile[x];
      for (let y = -half; y <= half; y++) {
        const t = half === 0 ? 0.5 : (y + half) / (half * 2);
        const col = t < 0.34 ? dark : t < 0.62 ? back : t < 0.86 ? mid : belly;
        px(ctx, x, spineRow + y, rgbToHex(col));
      }
    }
    // pectoral fin laid over the flank
    px(ctx, 2, spineRow + 1, rgbToHex(mixRgb(tail, belly, 0.4)));
    // tail: one pixel of peduncle, then a fan the depth of the body with a
    // single pixel notch, which is all the fork this size can carry
    for (let x = 9; x <= 12; x++) {
      const half = x === 9 ? 1 : 2;
      for (let y = -half; y <= half; y++) {
        if (x >= 10 && y === 0) continue;
        px(ctx, x, spineRow + y, rgbToHex(x === 12 ? rim : fin));
      }
    }
    // a pale flank line, then the eye
    for (let x = 2; x <= 6; x++) px(ctx, x, spineRow + 1, rgbToHex(mixRgb(belly, back, 0.22)));
    px(ctx, 1, spineRow, "#0e1116");
    px(ctx, 1, spineRow - 1, rgbToHex(mixRgb(belly, "#ffffff", 0.5)));
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
    // a tiny raft of two or three round leaves, not loose pixels: at four pixels
    // across the silhouette is what makes it read as duckweed
    const W = 6;
    const H = 5;
    const { c, ctx } = makeCanvas(W, H);
    const greens = ["#5f9b34", "#6fae3e", "#7cbb48", "#548c2d"];
    const leaves = rand.int(2, 3);
    const spots = [[1.5, 2], [3.6, 1.6], [3.4, 3.4], [1.6, 3.6]];
    for (let i = 0; i < leaves; i++) {
      const [cx, cy] = spots[i];
      const col = hexToRgb(rand.pick(greens));
      const r = rand.range(1.1, 1.5);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const dx = (x + 0.5 - cx) / r;
          const dy = (y + 0.5 - cy) / r;
          const d = dx * dx + dy * dy;
          if (d > 1) continue;
          // darker at the rim, a touch lighter on the top left
          const shade = d > 0.62 ? 0.82 : (dx + dy < -0.3 ? 1.14 : 1.0);
          px(ctx, x, y, rgbToHex(shadeRgb(col, shade)));
        }
      }
    }
    const hy = Math.round(rand.range(0, H - 1));
    px(ctx, Math.round(rand.range(0, W - 1)), hy, rgbToHex(shadeRgb(hexToRgb("#9bd268"), 1.05)));
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

  // A tobi-ishi: a flat cut stepping stone, seen from above. Bigger than a
  // pebble, because these are meant to be walked on: a lit top face, a bevel on
  // the uphill edge, a dark side, and a rim that separates it from the water.
  function paintSteppingStone(rand) {
    const W = 22;
    const H = 15;
    const { c, ctx } = makeCanvas(W, H);
    const base = hexToRgb("#a29b8c");
    const dark = shadeRgb(base, 0.52);
    const rx = rand.range(8.2, 9.4);
    const ry = rand.range(4.4, 5.2);
    const cx = W / 2 + rand.range(-0.6, 0.6);
    const cy = H / 2 - 1.2;
    // rim, one pixel proud all round, so the stone sits on the water
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const q = Math.hypot((x - cx) / (rx + 0.7), (y - cy) / (ry + 0.7));
        if (q <= 1) px(ctx, x, y, rgbToHex(dark));
      }
    }
    // the side of the slab, stepped down and to the right
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const q = Math.hypot((x - cx - 1.1) / rx, (y - cy - 2.0) / ry);
        if (q <= 1) px(ctx, x, y, rgbToHex(shadeRgb(base, 0.6)));
      }
    }
    // the top face
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const q = Math.hypot((x - cx) / rx, (y - cy) / ry) *
          (0.93 + valueNoise2(x * 0.8, y * 0.8 + 5) * 0.14);
        if (q > 1) continue;
        let col = mixRgb(shadeRgb(base, 1.18), shadeRgb(base, 0.88), smoothstep(0.25, 1, q));
        col = shadeRgb(col, 1 + (valueNoise2(x * 0.9, y * 0.9) - 0.5) * 0.1);
        px(ctx, x, y, rgbToHex(col));
      }
    }
    // bevel along the uphill edge, wet and catching the light
    for (let x = Math.round(cx - rx * 0.82); x <= Math.round(cx + rx * 0.5); x++) {
      const y = Math.round(cy - ry * 0.92 + Math.abs(x - cx) * 0.12);
      if (y < 0 || y >= H) continue;
      px(ctx, x, y, rgbToHex(shadeRgb(base, 1.32)));
    }
    // a wet sheen across the middle, and a chip out of the downhill corner
    px(ctx, Math.round(cx - rx * 0.3), Math.round(cy + ry * 0.1), rgbToHex(shadeRgb(base, 1.26)));
    px(ctx, Math.round(cx + rx * 0.66), Math.round(cy + ry * 0.7), rgbToHex(shadeRgb(base, 0.72)));
    harden(c);
    return c;
  }

  // ---- dragonfly ------------------------------------------------------------
  // Body up the middle with the head at the top, because the renderer draws it
  // rotated by heading + 90 degrees. Three wing poses make the beat read as a
  // blur: out flat, half swept, and lifted to a sliver.
  const DRAGONFLY_PALETTES = {
    emerald: { body: "#2f5a4a", back: "#4e8a6c", eyes: "#8ff0c8", tail: "#3d6f58" },
    blue: { body: "#2c4363", back: "#56789e", eyes: "#a8d8ff", tail: "#3a567c" },
    red: { body: "#6b2f2a", back: "#a85545", eyes: "#ffc9a8", tail: "#7d3a32" },
    bronze: { body: "#4a3a26", back: "#8a6f45", eyes: "#ffdca8", tail: "#5c472e" },
  };

  function paintDragonfly(rand, variant, wing) {
    const v = DRAGONFLY_PALETTES[variant] || DRAGONFLY_PALETTES.emerald;
    const W = 15;
    const H = 13;
    const { c, ctx } = makeCanvas(W, H);
    const body = hexToRgb(v.body);
    const back = hexToRgb(v.back);
    const eyes = hexToRgb(v.eyes);
    const tail = hexToRgb(v.tail);
    const wingPale = hexToRgb("#dff0f4");
    const wingEdge = hexToRgb("#9dc2cc");
    const cx = 7;
    // head and eyes
    px(ctx, cx, 0, rgbToHex(back));
    px(ctx, cx - 1, 1, rgbToHex(eyes));
    px(ctx, cx + 1, 1, rgbToHex(eyes));
    px(ctx, cx, 1, rgbToHex(shadeRgb(body, 0.7)));
    // thorax
    for (let y = 2; y <= 4; y++) {
      px(ctx, cx - 1, y, rgbToHex(back));
      px(ctx, cx, y, rgbToHex(body));
      px(ctx, cx + 1, y, rgbToHex(shadeRgb(body, 0.78)));
    }
    // abdomen, tapering to a point
    for (let y = 5; y <= 11; y++) {
      const t = (y - 5) / 6;
      const wide = t < 0.5 ? 1 : 0;
      for (let dx = -wide; dx <= wide; dx++) {
        const shade = dx < 0 ? 1.12 : dx > 0 ? 0.78 : 1;
        px(ctx, cx + dx, y, rgbToHex(shadeRgb(mixRgb(tail, body, t * 0.4), shade)));
      }
      if (y === 6 || y === 9) {
        px(ctx, cx - (wide + 1), y, rgbToHex(shadeRgb(tail, 0.85)));
        px(ctx, cx + (wide + 1), y, rgbToHex(shadeRgb(tail, 0.7)));
      }
    }
    px(ctx, cx, 12, rgbToHex(shadeRgb(tail, 0.65)));
    // four wings, two poses per side depending on the beat
    const wingRow = wing === 0 ? [3, 5] : wing === 1 ? [4, 6] : [2, 4];
    const reach = wing === 0 ? 5 : wing === 1 ? 3 : 2;
    const rise = wing === 2 ? -1 : 0;
    const drawWing = (dy, dir, long) => {
      for (let i = 1; i <= reach; i++) {
        const wx = cx + dir * (1 + i);
        const wy = wingRow[dy] + rise + (long ? 0 : i > 2 ? 1 : 0);
        if (wx < 0 || wx >= W || wy < 0 || wy >= H) continue;
        px(ctx, wx, wy, rgbToHex(i === reach ? wingEdge : wingPale));
      }
    };
    drawWing(0, -1, true);
    drawWing(0, 1, true);
    drawWing(1, -1, false);
    drawWing(1, 1, false);
    harden(c);
    return c;
  }


  // A water hyacinth: a rosette of blunt leaves over a swollen float, sitting
  // higher and lighter than a lily pad so the floating layer has two
  // silhouettes instead of one repeated shape.
  function paintWaterHyacinth(rand) {
    const W = 16;
    const H = 13;
    const { c, ctx } = makeCanvas(W, H);
    const cx = W / 2;
    const cy = H / 2 + 1;
    const leaf = hexToRgb("#4f8a3e");
    const leafLit = hexToRgb("#6faa52");
    const leafDark = hexToRgb("#315c2c");
    const float = hexToRgb("#8f6f52");
    // the swollen float underneath
    ellipse(ctx, cx, cy + 2.4, 4.4, 2.6, rgbToHex(shadeRgb(float, 0.9)));
    ellipse(ctx, cx, cy + 2.0, 3.2, 1.8, rgbToHex(shadeRgb(float, 1.06)));
    // six to nine rounded leaves fanned round the middle
    const n = rand.int(6, 9);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand.range(-0.12, 0.12);
      const r = rand.range(3.6, 5.2);
      const lx = cx + Math.cos(a) * r;
      const ly = cy + Math.sin(a) * r * 0.78;
      const rx = rand.range(2.0, 2.9);
      const ry = rand.range(1.7, 2.3);
      const lit = a > Math.PI * 1.05 && a < Math.PI * 1.85;
      ellipse(ctx, lx, ly, rx, ry, rgbToHex(lit ? leafLit : leaf));
      // a dark rim on the downhill side, one pixel in
      ellipse(ctx, lx + 0.3, ly + 0.6, rx - 0.9, ry - 0.7, rgbToHex(leafDark));
      ellipse(ctx, lx, ly - 0.2, rx - 1.1, ry - 0.9, rgbToHex(lit ? leafLit : leaf));
      px(ctx, Math.round(lx), Math.round(ly), rgbToHex(shadeRgb(leafLit, 1.15)));
    }
    harden(c);
    return c;
  }

  // The rowboat from the user's Figma file, node 2:2 (48x24). Kept as palette
  // rows rather than a loaded image so it paints into the same pixel grid as
  // everything else, stays crisp at 2x, and needs no async load at boot.
  const FIGMA_BOAT = {
    width: 48,
    height: 24,
    palette: {
      "a": "#2b2426",
      "b": "#c59d66",
      "c": "#8c9d92",
      "d": "#925f3b",
      "e": "#573c2a",
      "f": "#865f3e",
      "g": "#ceb082",
      "h": "#bc9668",
      "i": "#462e21",
      "j": "#d4b57d",
      "k": "#b17d43",
      "l": "#8b633f",
      "m": "#b6b49e",
      "n": "#967048",
      "o": "#66472c",
      "p": "#c2b085",
      "q": "#ad8456",
    },
    rows: [
      "................................................",
      "................................................",
      "................................................",
      "......aaaaaaaaaaaaaaaaaaaaaaaaa.................",
      ".....abbbbbbcbbbbbbbbbbcbbbbbbcaaa..............",
      "....adbddddddeffffddddddeffffddbbbaa............",
      "....adcghffijefcffeeeeeeefcffeedddbbaa..........",
      "....adbgcffkjjjhhfllllfleghhflmmeeddbba.........",
      "....adbghffiikkhhfnnnnfneghhkkiinneehbba........",
      "....adbghffooiijkfooeofoegkjiiofoppohbhba.......",
      "....adbghffqqegiikklllflkkiifqqfpepphbhcba......",
      "....adbgqffqqegfhiijkjkjiifhfqqfppephfhbhba.....",
      "....adbgfffooegqhfojkiiiegqhfoofoppohbfbhba.....",
      "....adbghffeqeghqkkiiiiikkhqfeqfllpphbhcba......",
      "....adbghffqnjjjkiiqqqfqiikjfnnqnnnnhbhba.......",
      "....adbghffijkkiifooooeoegiikkofooeehbba........",
      "....adbgcffkjiihhfllllfleghhiimmeeddbba.........",
      "....adcghffiiefcffeeeefeefcffeiiddbbaa..........",
      "....adbddddddeffffddddddeffffddbbbaa............",
      ".....abbbbbbcbbbbbbbbbbcbbbbbbcaaa..............",
      "......aaaaaaaaaaaaaaaaaaaaaaaaa.................",
      "................................................",
      "................................................",
      "................................................",
    ],
  };
  function paintBoat(rand) {
    // three world pixels per design texel: the hull is 144 long, about three
    // times the biggest koi, which is where a rowboat reads next to 30-46px fish
    const S = 3;
    const DW = FIGMA_BOAT.width;
    const DH = FIGMA_BOAT.height;
    const { c, ctx } = makeCanvas(DW * S, DH * S);
    const pal = FIGMA_BOAT.palette;
    for (let y = 0; y < DH; y++) {
      const row = FIGMA_BOAT.rows[y];
      for (let x = 0; x < DW; x++) {
        const key = row[x];
        if (!key || key === ".") continue;
        const hex = pal[key];
        if (!hex) continue;
        ctx.fillStyle = hex;
        ctx.fillRect(x * S, y * S, S, S);
      }
    }
    void rand;
    harden(c);
    return { canvas: c, width: DW * S, height: DH * S };
  }

  // A clay pot lying on its side in the shallows, half silted in. Terracotta,
  // a dark mouth, an algae fringe along the rim: the one thing in the pond a
  // person clearly put there for the fish.
  function paintClayPot(rand) {
    const W = 24;
    const H = 16;
    const { c, ctx } = makeCanvas(W, H);
    const clay = hexToRgb("#a4573a");
    const clayLit = hexToRgb("#c0714c");
    const clayDark = hexToRgb("#6d3826");
    const algae = hexToRgb("#5c8a4a");
    // body: a barrel lying across, mouth on the right
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const rx = (x - 11) / 9.2;
        const ry = (y - 8) / 5.2;
        if (rx * rx + ry * ry > 1) continue;
        const band = 0.5 + 0.5 * Math.sin(x * 0.55);
        let col = mixRgb(clayDark, clayLit, 0.25 + 0.6 * band);
        if (y < 5) col = shadeRgb(col, 1.12);
        if (y > 11) col = shadeRgb(col, 0.82);
        px(ctx, x, y, rgbToHex(col));
      }
    }
    // the mouth: dark inside with a pale lip
    ellipse(ctx, 19, 8, 4.0, 4.6, rgbToHex(clayLit));
    ellipse(ctx, 19.4, 8, 3.0, 3.6, rgbToHex(hexToRgb("#1b2320")));
    ellipse(ctx, 19.6, 8.4, 2.0, 2.4, rgbToHex(hexToRgb("#0d1210")));
    // algae along the upper rim and a drift of silt at the foot
    for (let i = 0; i < 10; i++) {
      const ax = Math.round(rand.range(3, 19));
      const ay = Math.round(rand.range(3, 6));
      px(ctx, ax, ay, rgbToHex(shadeRgb(algae, 1 + rand.range(-0.15, 0.2))));
    }
    for (let i = 0; i < 7; i++) {
      px(ctx, Math.round(rand.range(2, 20)), Math.round(rand.range(13, 15)), rgbToHex(shadeRgb(hexToRgb("#7b7461"), 1 + rand.range(-0.1, 0.1))));
    }
    harden(c);
    return c;
  }

  // A water strider: a slim body with four legs and a pale highlight, drawn
  // small because it lives on the surface and its shadow is four dimples, not a
  // body shadow.
  function paintStrider(rand) {
    const W = 9;
    const H = 7;
    const { c, ctx } = makeCanvas(W, H);
    const body = hexToRgb("#2b2b30");
    const lit = hexToRgb("#8f9aa0");
    // legs: two forward, two back, splayed
    for (const [dx, dy] of [[-3, -2], [3, -2], [-3, 2], [3, 2]]) {
      px(ctx, 4 + dx, 3 + dy, rgbToHex(shadeRgb(body, 0.9)));
      px(ctx, 4 + Math.round(dx * 0.6), 3 + Math.round(dy * 0.6), rgbToHex(body));
    }
    // body
    for (let x = 2; x <= 6; x++) px(ctx, x, 3, rgbToHex(body));
    px(ctx, 4, 2, rgbToHex(lit));
    px(ctx, 5, 4, rgbToHex(shadeRgb(body, 0.7)));
    harden(c);
    return c;
  }

  return {
    makeCanvas, harden, outline, measureExtents, extentsAt,
    paintKoi, paintMinnow, paintButterfly, paintButterflyRest,
    paintLilyPad, paintLotusFlower, paintMossClump, paintStone,
    paintGrassTuft, paintReedClump, paintShoreFlower, paintDuckweed, paintBlob, paintPondWeed, paintFloatingMoss,
    paintSteppingStone, paintDragonfly, paintWaterHyacinth, paintClayPot, paintStrider, paintBoat,
    KOI_DESIGNS, MINNOW_VARIANTS, DRAGONFLY_PALETTES,
  };
})();
