// The pond shape: an ellipse with a wobbled shoreline. The wobble is baked
// once into a 64-value table that the CPU and the water shader both read, so
// fish steering and the painted water edge can never disagree.
"use strict";

function makeRimTable() {
  const table = new Float32Array(64);
  const p = CONFIG.ponds;
  for (let i = 0; i < 64; i++) {
    const a = (i / 64 - 0.5) * TAU;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const n1 = valueNoise2(dx * 2.2 + 3.7, dy * 2.2 + 1.9);
    const n2 = valueNoise2(dx * 5.3 + 11.3, dy * 5.3 + 7.1);
    table[i] = 1 + (n1 - 0.5) * p.wobbleA + (n2 - 0.5) * p.wobbleB;
  }
  return table;
}

function rimFactor(table, angle) {
  const f = (angle / TAU + 0.5) * 64;
  const i0 = ((Math.floor(f) % 64) + 64) % 64;
  const j = (i0 + 1) % 64;
  const fr = f - Math.floor(f);
  return table[i0] + (table[j] - table[i0]) * fr;
}

function createPond(res, rimTable) {
  const p = CONFIG.ponds;
  const cx = res.x * 0.5;
  const cy = res.y * 0.5;
  // the ellipse reaches past every edge of the frame, and the wobbled rim
  // rides on it, so no shoreline is ever visible inside the canvas
  const rx = res.x * p.overscan;
  const ry = res.y * p.overscan;

  // 0 at the deepest point, ~0.5-0.7 at the corners of the frame
  const d = (x, y) => {
    const qx = (x - cx) / rx;
    const qy = (y - cy) / ry;
    return Math.hypot(qx, qy) / rimFactor(rimTable, Math.atan2(qy, qx));
  };

  const pointAt = (angle, factor) => ({
    x: cx + Math.cos(angle) * rx * factor * rimFactor(rimTable, angle),
    y: cy + Math.sin(angle) * ry * factor * rimFactor(rimTable, angle),
  });

  return {
    cx, cy, rx, ry, d, pointAt,
    inward(x, y) {
      const dx = cx - x;
      const dy = cy - y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: dx / len, y: dy / len };
    },
    // any point inside the frame, optionally preferring the shallows
    randomPoint(rand, maxD = 0.8, minD = 0) {
      for (let i = 0; i < 60; i++) {
        const x = rand.range(8, Math.max(16, res.x - 8));
        const y = rand.range(8, Math.max(16, res.y - 8));
        const pd = d(x, y);
        if (pd <= maxD && pd >= minD) return { x, y };
      }
      return { x: cx, y: cy };
    },
    // a point right at the frame border (inset < 0 sits just outside the view)
    edgePoint(rand, inset) {
      const side = rand.int(0, 3);
      if (side === 0) return { x: rand.range(6, res.x - 6), y: -inset };
      if (side === 1) return { x: res.x + inset, y: rand.range(6, res.y - 6) };
      if (side === 2) return { x: rand.range(6, res.x - 6), y: res.y + inset };
      return { x: -inset, y: rand.range(6, res.y - 6) };
    },
    // depth 0..1 of the floor below a point (0 = the deepest spot)
    floorDepth(x, y) {
      return clamp(d(x, y), 0, 1);
    },
  };
}
