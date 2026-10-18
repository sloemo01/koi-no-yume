// A small incompressible flow field for the pond surface.
//
// Stable-fluids style: advect the velocity by itself, then project it back onto
// divergence-free motion so it cannot pile up. Runs on a coarse grid (one cell
// per six world pixels) because the field only has to feel right, not be exact:
// its job is to carry duckweed, hyacinth, bubbles and pellets, and to leave
// swirls in the lee of the stepping stones.
//
// Units: velocity is cells per second internally. sample() converts to world
// pixels per second so callers can just add it to a position.
"use strict";

class FlowField {
  constructor(res, cell) {
    this.cell = cell || 6;
    this.cols = Math.max(10, Math.floor(res.x / this.cell));
    this.rows = Math.max(10, Math.floor(res.y / this.cell));
    const n = this.cols * this.rows;
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.u0 = new Float32Array(n);
    this.v0 = new Float32Array(n);
    this.p = new Float32Array(n);
    this.div = new Float32Array(n);
    this.curl = new Float32Array(n);
    this.solid = new Uint8Array(n);
    this.res = res;
    this.time = 0;
    this.iterations = 14;
    this.drift = 0.55;      // ambient current, cells per second
    this.vorticity = 0.75;  // how hard eddies are kept alive
  }

  index(cx, cy) { return cy * this.cols + cx; }

  cellX(x) { return x / this.cell; }
  cellY(y) { return y / this.cell; }

  // -- obstacles -------------------------------------------------------------
  // Anything that stands in the water blocks it, so the flow parts around it
  // and closes again behind it.
  build(scenery) {
    this.solid.fill(0);
    const mark = (x, y, rx, ry) => {
      const c0 = Math.max(1, Math.floor((x - rx) / this.cell));
      const c1 = Math.min(this.cols - 2, Math.ceil((x + rx) / this.cell));
      const r0 = Math.max(1, Math.floor((y - ry) / this.cell));
      const r1 = Math.min(this.rows - 2, Math.ceil((y + ry) / this.cell));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const dx = (c + 0.5) * this.cell - x;
          const dy = (r + 0.5) * this.cell - y;
          if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1) this.solid[this.index(c, r)] = 1;
        }
      }
    };
    if (scenery) {
      for (const st of (scenery.steppingStones || [])) mark(st.x, st.y, st.w * 0.42, st.h * 0.42);
      if (scenery.pot) mark(scenery.pot.x, scenery.pot.y, scenery.pot.w * 0.4, scenery.pot.h * 0.42);
    }
    // the frame edge is a wall
    for (let c = 0; c < this.cols; c++) {
      this.solid[this.index(c, 0)] = 1;
      this.solid[this.index(c, this.rows - 1)] = 1;
    }
    for (let r = 0; r < this.rows; r++) {
      this.solid[this.index(0, r)] = 1;
      this.solid[this.index(this.cols - 1, r)] = 1;
    }
  }

  // a shove at a point: clicks, splashes, a fish letting go
  impulse(x, y, strength, radius) {
    const cx = this.cellX(x);
    const cy = this.cellY(y);
    const rad = (radius || 14) / this.cell;
    const c0 = Math.max(1, Math.floor(cx - rad));
    const c1 = Math.min(this.cols - 2, Math.ceil(cx + rad));
    const r0 = Math.max(1, Math.floor(cy - rad));
    const r1 = Math.min(this.rows - 2, Math.ceil(cy + rad));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const dx = c + 0.5 - cx;
        const dy = r + 0.5 - cy;
        const d = Math.hypot(dx, dy);
        if (d < 1e-3 || d > rad) continue;
        const fall = (1 - d / rad) ** 2;
        const i = this.index(c, r);
        if (this.solid[i]) continue;
        this.u[i] += (dx / d) * strength * fall;
        this.v[i] += (dy / d) * strength * fall;
      }
    }
  }

  // a fish tail pushing water the other way
  wake(x, y, dx, dy, strength, radius) {
    const cx = this.cellX(x);
    const cy = this.cellY(y);
    const rad = (radius || 10) / this.cell;
    const c0 = Math.max(1, Math.floor(cx - rad));
    const c1 = Math.min(this.cols - 2, Math.ceil(cx + rad));
    const r0 = Math.max(1, Math.floor(cy - rad));
    const r1 = Math.min(this.rows - 2, Math.ceil(cy + rad));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const px = c + 0.5 - cx;
        const py = r + 0.5 - cy;
        const d = Math.hypot(px, py);
        if (d > rad) continue;
        const i = this.index(c, r);
        if (this.solid[i]) continue;
        const fall = (1 - d / rad) ** 2;
        this.u[i] += dx * strength * fall;
        this.v[i] += dy * strength * fall;
      }
    }
  }

  // -- field reads -----------------------------------------------------------
  sampleInto(arr, cx, cy) {
    const c = Math.min(this.cols - 1.001, Math.max(0, cx - 0.5));
    const r = Math.min(this.rows - 1.001, Math.max(0, cy - 0.5));
    const c0 = Math.floor(c);
    const r0 = Math.floor(r);
    const fx = c - c0;
    const fy = r - r0;
    const i00 = this.index(c0, r0);
    const i10 = this.index(c0 + 1, r0);
    const i01 = this.index(c0, r0 + 1);
    const i11 = this.index(c0 + 1, r0 + 1);
    const a = arr[i00] * (1 - fx) + arr[i10] * fx;
    const b = arr[i01] * (1 - fx) + arr[i11] * fx;
    return a * (1 - fy) + b * fy;
  }

  // world pixels per second at a point
  sample(x, y, out) {
    const u = this.sampleInto(this.u, this.cellX(x), this.cellY(y));
    const v = this.sampleInto(this.v, this.cellX(x), this.cellY(y));
    const k = this.cell;
    if (out) { out.x = u * k; out.y = v * k; return out; }
    return { x: u * k, y: v * k };
  }

  speedAt(x, y) {
    const u = this.sampleInto(this.u, this.cellX(x), this.cellY(y));
    const v = this.sampleInto(this.v, this.cellX(x), this.cellY(y));
    return Math.hypot(u, v) * this.cell;
  }

  // -- the step --------------------------------------------------------------
  step(dt, scenery) {
    const d = Math.min(0.05, Math.max(0.008, dt));
    this.time += d;
    const t = this.time;

    // ambient current: a slow breeze that changes direction over minutes, plus a
    // steady through-flow so the pond is not perfectly still
    const ang = Math.sin(t * 0.037) * 1.1 + Math.cos(t * 0.013) * 0.4;
    const force = this.drift * 0.05;
    // Drag, or the field accelerates forever: advection and projection only
    // rearrange momentum, neither of them removes it. With drag the ambient
    // force settles at a terminal speed instead of turning the pond into a river.
    const drag = Math.exp(-d * 3.2);
    for (let r = 1; r < this.rows - 1; r++) {
      for (let c = 1; c < this.cols - 1; c++) {
        const i = this.index(c, r);
        if (this.solid[i]) { this.u[i] = 0; this.v[i] = 0; continue; }
        this.u[i] = (this.u[i] + Math.cos(ang) * force) * drag;
        this.v[i] = (this.v[i] + Math.sin(ang) * force) * drag;
        // a splash can spike a cell; clamp it so the whole field does not follow
        const sp = Math.hypot(this.u[i], this.v[i]);
        if (sp > 4.5) {
          this.u[i] *= 4.5 / sp;
          this.v[i] *= 4.5 / sp;
        }
      }
    }

    // fish push water as they swim, which is what makes wakes behind them
    if (scenery && scenery.koi) {
      for (const k of scenery.koi) {
        if (k.depth > 0.4) continue;
        const sp = Math.hypot(k.vx || 0, k.vy || 0);
        if (sp < 4) continue;
        const bx = k.x - Math.cos(k.heading) * (k.length || 20) * 0.5;
        const by = k.y - Math.sin(k.heading) * (k.length || 20) * 0.5;
        this.wake(bx, by, -Math.cos(k.heading), -Math.sin(k.heading), Math.min(0.5, sp * 0.006), 9);
      }
    }

    this.advect(d);
    this.project();
    this.confineVorticity(d);
  }

  advect(dt) {
    this.u0.set(this.u);
    this.v0.set(this.v);
    const step = dt;
    for (let r = 1; r < this.rows - 1; r++) {
      for (let c = 1; c < this.cols - 1; c++) {
        const i = this.index(c, r);
        if (this.solid[i]) continue;
        const x = c + 0.5 - this.u0[i] * step;
        const y = r + 0.5 - this.v0[i] * step;
        this.u[i] = this.sampleInto(this.u0, x, y);
        this.v[i] = this.sampleInto(this.v0, x, y);
      }
    }
  }

  project() {
    const { cols, rows } = this;
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = this.index(c, r);
        if (this.solid[i]) { this.div[i] = 0; continue; }
        const l = this.solid[this.index(c - 1, r)] ? 0 : this.u[this.index(c - 1, r)];
        const rr = this.solid[this.index(c + 1, r)] ? 0 : this.u[this.index(c + 1, r)];
        const up = this.solid[this.index(c, r - 1)] ? 0 : this.v[this.index(c, r - 1)];
        const dn = this.solid[this.index(c, r + 1)] ? 0 : this.v[this.index(c, r + 1)];
        this.div[i] = -0.5 * (rr - l + dn - up);
        this.p[i] = 0;
      }
    }
    for (let k = 0; k < this.iterations; k++) {
      for (let r = 1; r < rows - 1; r++) {
        for (let c = 1; c < cols - 1; c++) {
          const i = this.index(c, r);
          if (this.solid[i]) { this.p[i] = 0; continue; }
          const l = this.solid[this.index(c - 1, r)] ? this.p[i] : this.p[this.index(c - 1, r)];
          const rr = this.solid[this.index(c + 1, r)] ? this.p[i] : this.p[this.index(c + 1, r)];
          const up = this.solid[this.index(c, r - 1)] ? this.p[i] : this.p[this.index(c, r - 1)];
          const dn = this.solid[this.index(c, r + 1)] ? this.p[i] : this.p[this.index(c, r + 1)];
          this.p[i] = (this.div[i] + l + rr + up + dn) * 0.25;
        }
      }
    }
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = this.index(c, r);
        if (this.solid[i]) { this.u[i] = 0; this.v[i] = 0; continue; }
        const pl = this.solid[this.index(c - 1, r)] ? this.p[i] : this.p[this.index(c - 1, r)];
        const pr = this.solid[this.index(c + 1, r)] ? this.p[i] : this.p[this.index(c + 1, r)];
        const pu = this.solid[this.index(c, r - 1)] ? this.p[i] : this.p[this.index(c, r - 1)];
        const pd = this.solid[this.index(c, r + 1)] ? this.p[i] : this.p[this.index(c, r + 1)];
        this.u[i] -= 0.5 * (pr - pl);
        this.v[i] -= 0.5 * (pd - pu);
      }
    }
  }

  // keep the eddies from smearing out: push each cell towards the local curl
  confineVorticity(dt) {
    const { cols, rows } = this;
    const eps = this.vorticity;
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = this.index(c, r);
        if (this.solid[i]) { this.curl[i] = 0; continue; }
        this.curl[i] = 0.5 * (
          (this.v[this.index(c + 1, r)] - this.v[this.index(c - 1, r)]) -
          (this.u[this.index(c, r + 1)] - this.u[this.index(c, r - 1)])
        );
      }
    }
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = this.index(c, r);
        if (this.solid[i]) continue;
        const gx = Math.abs(this.curl[this.index(c + 1, r)]) - Math.abs(this.curl[this.index(c - 1, r)]);
        const gy = Math.abs(this.curl[this.index(c, r + 1)]) - Math.abs(this.curl[this.index(c, r - 1)]);
        const len = Math.hypot(gx, gy) + 1e-5;
        const k = this.curl[i];
        this.u[i] += (gy / len) * k * eps * dt * 0.5;
        this.v[i] -= (gx / len) * k * eps * dt * 0.5;
      }
    }
  }

  // total kinetic energy, handy for a test
  energy() {
    let e = 0;
    for (let i = 0; i < this.u.length; i++) e += this.u[i] * this.u[i] + this.v[i] * this.v[i];
    return Math.sqrt(e / this.u.length) * this.cell;
  }
}
