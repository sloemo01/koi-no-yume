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

  // half-width of the body at t along the body (0 nose .. 1 tail root)
  const KOI_BODY_PROFILE = [
    [0, 0.30], [0.07, 0.78], [0.17, 0.95], [0.34, 1.0],
    [0.56, 0.9], [0.74, 0.7], [0.88, 0.48], [1, 0.3],
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

  const KOI_VARIETIES = {
    kohaku: { base: ["#f7f2e6", "#efe7d5"], marks: [{ colors: ["#d8401f", "#c23318", "#e2542a"], n: [2, 4], saddle: true, cover: 0.55 }] },
    sanke: { base: ["#f7f2e6", "#efe7d5"], marks: [
      { colors: ["#d8401f", "#cf3d1e"], n: [2, 3], saddle: true, cover: 0.45 },
      { colors: ["#191922", "#232331"], n: [3, 5], speckle: true, cover: 0.16 },
    ] },
    showa: { base: ["#1b1b24", "#15151d"], marks: [
      { colors: ["#d8401f", "#c93a1c"], n: [2, 3], saddle: true, cover: 0.4 },
      { colors: ["#f4efe4", "#efe9db"], n: [2, 3], saddle: true, cover: 0.35 },
    ] },
    utsuri: { base: ["#1b1b24", "#141419"], marks: [{ colors: ["#f4efe4", "#eee8d8"], n: [2, 3], saddle: true, cover: 0.4 }] },
    bekko: { base: ["#f2ecd9", "#ece2c6"], marks: [{ colors: ["#17171e", "#20202a"], n: [4, 7], speckle: true, cover: 0.2 }] },
    tancho: { base: ["#f8f3ea", "#f0ead9"], marks: [], crown: true },
    ogon: { base: ["#e5b13f", "#d9a232"], marks: [], sheen: "#fbe7a8", net: 0.3 },
    platinum: { base: ["#eef0ee", "#e2e6e4"], marks: [], sheen: "#ffffff", net: 0.24 },
    asagi: { base: ["#8397a8", "#74899b"], marks: [{ colors: ["#d86a35", "#cf6030"], n: [2, 3], edge: true, cover: 0.16 }], net: 0.5 },
    chagoi: { base: ["#9c7a45", "#8a6a3c"], marks: [], net: 0.85 },
  };

  // an organic blob: overlapping ellipses with jitter, at pixel scale
  function blotch(ctx, rand, cx, cy, w, h, color, clip) {
    const n = 3 + Math.floor(rand.unit() * 3);
    for (let i = 0; i < n; i++) {
      const x = cx + rand.range(-w * 0.34, w * 0.34);
      const y = cy + rand.range(-h * 0.3, h * 0.3);
      if (clip && !clip(x, y)) continue;
      ellipse(ctx, x, y, rand.range(w * 0.45, w * 0.95), rand.range(h * 0.45, h * 0.95), color);
    }
  }

  // a koi lying nose-left, seen from directly above. Returns the canvas plus
  // the silhouette table the bend mesh rides on.
  function paintKoi(rand, varietyName, length) {
    const v = KOI_VARIETIES[varietyName] || KOI_VARIETIES.kohaku;
    const L = Math.round(length);
    // a top-view koi wants length/width around 4.5-5 to read as slim
    const H = Math.max(9, Math.round(L * 0.3));
    const { c, ctx } = makeCanvas(L, H);
    const spineRow = Math.floor(H / 2);
    const bodyLen = Math.round(L * 0.74);
    const maxHalf = spineRow - 2;
    const base0 = hexToRgb(v.base[0]);
    const base1 = hexToRgb(v.base[1]);
    const dark = rgbToHex(shadeRgb(mixRgb(base0, [20, 18, 22], 0.62), 0.9));

    const inBody = (x, y) => {
      if (x < 0 || x >= bodyLen) return false;
      const t = x / Math.max(1, bodyLen - 1);
      const hw = maxHalf * bodyHalfAt(t);
      return Math.abs(y - spineRow) <= hw;
    };

    // base coat with a slow head-to-tail gradient plus a touch of jitter
    for (let x = 0; x < bodyLen; x++) {
      const t = x / Math.max(1, bodyLen - 1);
      const hw = Math.max(1, Math.round(maxHalf * bodyHalfAt(t)));
      const col = rgbToHex(mixRgb(base0, base1, t * 0.9 + rand.range(-0.02, 0.02)));
      solid(ctx, x, spineRow - hw, 1, hw * 2 + 1, col);
    }

    // markings
    for (const layer of v.marks || []) {
      const count = rand.int(layer.n[0], layer.n[1]);
      for (let i = 0; i < count; i++) {
        const color = rand.pick(layer.colors);
        if (layer.saddle) {
          const cx = bodyLen * rand.range(0.2, 0.86);
          const w = bodyLen * rand.range(0.1, 0.19) * (1 + layer.cover);
          const t = cx / Math.max(1, bodyLen - 1);
          const hw = maxHalf * bodyHalfAt(t);
          blotch(ctx, rand, cx, spineRow + rand.range(-2, 2), w * 0.6, hw * rand.range(0.7, 1.0), color, inBody);
        } else if (layer.speckle) {
          const cx = bodyLen * rand.range(0.15, 0.9);
          const cy = spineRow + rand.range(-maxHalf * 0.8, maxHalf * 0.8);
          const spread = bodyLen * 0.14;
          const n = rand.int(4, 9);
          for (let k = 0; k < n; k++) {
            const x = Math.round(cx + rand.range(-spread, spread));
            const y = Math.round(cy + rand.range(-maxHalf * 0.9, maxHalf * 0.9));
            if (inBody(x, y)) solid(ctx, x, y, rand.chance(0.35) ? 2 : 1, 1, color);
          }
        } else if (layer.edge) {
          // asagi-style: small orange marks that hug the body edge
          const side = rand.sign();
          const cx = bodyLen * rand.range(0.25, 0.85);
          const t = cx / Math.max(1, bodyLen - 1);
          const hw = maxHalf * bodyHalfAt(t);
          const cy = spineRow + side * hw * rand.range(0.55, 0.9);
          blotch(ctx, rand, cx, cy, 2.5, hw * 0.3, color, inBody);
        }
      }
    }

    // scale net: 1px staggered flecks, only a whisper of contrast
    if (v.net) {
      const netCol = rgbToHex(shadeRgb(base0, 0.9));
      const step = 2 + (v.net > 0.6 ? 0 : 1);
      for (let x = 2; x < bodyLen; x += step) {
        const row = (x / step) | 0;
        for (let y = spineRow - maxHalf + ((row % 2) ? 0 : 1); y <= spineRow + maxHalf; y += 2) {
          if (inBody(x, y) && y !== spineRow) px(ctx, x, y, netCol);
        }
      }
    }

    // metallic sheen: a soft stripe down the spine
    if (v.sheen) {
      const sheenRgb = hexToRgb(v.sheen);
      for (let x = 2; x < bodyLen - 2; x++) {
        const t = x / Math.max(1, bodyLen - 1);
        const hw = maxHalf * bodyHalfAt(t);
        const band = Math.max(1, Math.round(hw * 0.5));
        for (let y = spineRow - band; y <= spineRow + band; y++) {
          if (!inBody(x, y)) continue;
          const k = 0.35 - (Math.abs(y - spineRow) / Math.max(1, band)) * 0.3;
          const cur = ctx.getImageData(x, y, 1, 1).data;
          ctx.fillStyle = rgbToHex(mixRgb([cur[0], cur[1], cur[2]], sheenRgb, Math.max(0, k)));
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    // dorsal ridge: a darker line down the back half of the spine
    const ridgeCol = rgbToHex(shadeRgb(base0, v.base[0] === "#1b1b24" ? 1.5 : 0.86));
    for (let x = Math.round(bodyLen * 0.45); x < bodyLen; x++) {
      px(ctx, x, spineRow, ridgeCol);
    }

    // tancho: one clean red crown between the eyes
    if (v.crown) {
      const cx = Math.round(bodyLen * 0.2);
      ellipse(ctx, cx, spineRow, Math.max(2, L * 0.045), Math.max(2, (maxHalf * 0.62)), "#d8401f");
    }

    // pectoral fins: short rounded lobes tucked at the gills
    const finCol = rgbToHex(v.base[0] === "#1b1b24" || v.base[0] === "#9c7a45" ? shadeRgb(base0, 1.5) : shadeRgb(base0, 0.93));
    for (const side of [-1, 1]) {
      const gx = Math.round(bodyLen * 0.24);
      const t = gx / Math.max(1, bodyLen - 1);
      const hw = maxHalf * bodyHalfAt(t);
      const reach = Math.max(2, Math.round(hw * rand.range(0.65, 0.95)));
      for (let i = 0; i < reach; i++) {
        const y = spineRow + side * (hw + i);
        if (y < 0 || y >= H) break;
        const w = Math.max(1, Math.round(reach * 0.55 - i * 0.4));
        solid(ctx, gx - (w >> 1), y, w, 1, finCol);
      }
    }

    // tail fan: flares from the peduncle, forked at the tip
    const tailCol = rgbToHex(v.base[0] === "#1b1b24" || v.base[0] === "#9c7a45" ? shadeRgb(base0, 1.45) : shadeRgb(base0, 0.95));
    const tailCol2 = rgbToHex(shadeRgb(hexToRgb(tailCol), 0.82));
    const rootT = 0.74;
    const rootHalf = maxHalf * bodyHalfAt(1) + 1;
    for (let x = bodyLen; x < L; x++) {
      const p = (x - bodyLen) / Math.max(1, (L - 1) - bodyLen);
      const half = rootHalf + (maxHalf * 1.15 - rootHalf) * Math.pow(p, 0.72);
      const notch = p > 0.62 ? ((p - 0.62) / 0.38) * rootHalf * 0.6 : 0;
      for (const side of [-1, 1]) {
        const y0 = spineRow;
        const y1 = spineRow + side * (half - notch);
        const lo = Math.min(y0, y1);
        const hi = Math.max(y0, y1);
        for (let y = Math.round(lo); y <= Math.round(hi); y++) {
          if (y < 0 || y >= H) continue;
          const inner = Math.abs(y - spineRow) < half * 0.45;
          px(ctx, x, y, inner ? tailCol : tailCol2);
        }
      }
    }
    // tail rays
    for (let r = 0; r < 2; r++) {
      const p = 0.45 + r * 0.35;
      const x = bodyLen + Math.round(p * (L - 1 - bodyLen));
      for (const side of [-1, 1]) {
        const half = rootHalf + (maxHalf * 1.15 - rootHalf) * Math.pow(p, 0.72);
        const y = Math.round(spineRow + side * half * 0.78);
        if (y >= 0 && y < H) px(ctx, x, y, tailCol2);
      }
    }

    // eyes: pale chip with a dark centre on dark fish, plain dark pair otherwise
    const eyeX = Math.max(1, Math.round(bodyLen * 0.075));
    const eyeHalf = Math.max(1, Math.round(maxHalf * bodyHalfAt(eyeX / bodyLen) * 0.62));
    const darkBase = base0[0] + base0[1] + base0[2] < 260;
    for (const side of [-1, 1]) {
      const y = spineRow + side * eyeHalf;
      if (darkBase) {
        px(ctx, eyeX - 1, y, "#cfd3cf");
        px(ctx, eyeX, y, "#14141a");
      } else {
        px(ctx, eyeX, y, "#1a1a20");
      }
    }

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

  function paintLilyPad(rand, size) {
    const S = Math.round(size);
    const { c, ctx } = makeCanvas(S, S);
    const cx = S / 2 - 0.5;
    const cy = S / 2 - 0.5;
    const r = S / 2 - 1;
    const green = [88, 128, 58];
    const light = [116, 158, 74];
    const dark = [58, 92, 44];
    const notch = rand.range(-0.5, 0.5);
    const notchWidth = rand.range(0.22, 0.36) * TAU;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const a = Math.atan2(dy, dx);
        const da = Math.abs(wrapAngle(a - notch));
        if (da < notchWidth / 2) continue; // the wedge cut
        // only a gentle wobble: pads should read as clean round leaves
        const edge = r * (0.965 + valueNoise2(Math.cos(a) * 3 + 31, Math.sin(a) * 3) * 0.07);
        if (d > edge) continue;
        const t = d / r;
        let col = mixRgb(light, green, smoothstep(0.3, 0.92, t));
        if (d > edge - 1.5) col = dark;
        col = shadeRgb(col, 1 + (valueNoise2(x * 0.4, y * 0.4) - 0.5) * 0.1);
        px(ctx, x, y, rgbToHex(col));
      }
    }
    // veins
    const veins = rand.int(4, 6);
    for (let i = 0; i < veins; i++) {
      const a = notch + notchWidth / 2 + (i / veins) * (TAU - notchWidth) + rand.range(-0.1, 0.1);
      for (let d = r * 0.25; d < r * 0.88; d += 1) {
        const x = Math.round(cx + Math.cos(a) * d);
        const y = Math.round(cy + Math.sin(a) * d);
        px(ctx, x, y, rgbToHex(mixRgb(dark, green, 0.45)));
      }
    }
    ellipse(ctx, cx, cy, Math.max(1, r * 0.2), Math.max(1, r * 0.2), rgbToHex(mixRgb(light, green, 0.35)));
    harden(c);
    return c;
  }

  function paintLotusFlower(rand, colorway, size) {
    const S = Math.round(size);
    const { c, ctx } = makeCanvas(S, S);
    const cx = S / 2;
    const cy = S / 2;
    const petals = rand.int(5, 7);
    const cols = {
      pink: ["#f2a8c0", "#e07a9e", "#c95c82"],
      white: ["#ffffff", "#f0ece0", "#d8d2c2"],
      red: ["#e2556a", "#c93a52", "#a82c42"],
    }[colorway] || ["#f2a8c0", "#e07a9e", "#c95c82"];
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * TAU + rand.range(-0.12, 0.12);
      const len = S * rand.range(0.3, 0.42);
      const wid = S * rand.range(0.1, 0.15);
      const px1 = cx + Math.cos(a) * len * 0.55;
      const py1 = cy + Math.sin(a) * len * 0.55;
      ctx.fillStyle = i % 2 ? cols[0] : cols[1];
      ctx.beginPath();
      ctx.ellipse(px1, py1, wid, len * 0.62, a, 0, TAU);
      ctx.fill();
    }
    ellipse(ctx, cx, cy, S * 0.16, S * 0.16, cols[2]);
    ellipse(ctx, cx, cy, S * 0.09, S * 0.09, "#f2d45c");
    px(ctx, Math.round(cx), Math.round(cy), "#e8b93c");
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
    paintGrassTuft, paintReedClump, paintShoreFlower, paintDuckweed, paintBlob,
    KOI_VARIETIES, MINNOW_VARIANTS,
  };
})();
