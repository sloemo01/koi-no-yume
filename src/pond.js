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
  const cx = res.x * p.cx;
  const cy = res.y * p.cy;
  const rx = res.x * p.rx;
  // on a tall/narrow viewport the pond must not spill out of the frame
  const ry = Math.min(res.y * p.ry, rx * 1.3);

  // 0 at the middle, 1 at the shoreline
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
    // a point in open water between minD and maxD
    randomPoint(rand, maxD = 0.8, minD = 0.12) {
      for (let i = 0; i < 60; i++) {
        const x = cx + rand.range(-1, 1) * rx;
        const y = cy + rand.range(-1, 1) * ry;
        const pd = d(x, y);
        if (pd <= maxD && pd >= minD) return { x, y };
      }
      return { x: cx, y: cy };
    },
    // a point right at the waterline
    rimPoint(rand, f0 = 0.94, f1 = 1.06) {
      const angle = rand.angle();
      return pointAt(angle, rand.range(f0, f1));
    },
    // depth 0..1 of the floor below a point (0 = right at the surface rim)
    floorDepth(x, y) {
      return clamp(d(x, y), 0, 1);
    },
  };
}
