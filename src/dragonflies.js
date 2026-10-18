// Dragonflies. They do not wander like butterflies: they hold station, then
// dart. A hover is a small figure of eight around an anchor point, a dart is a
// straight burst to a new anchor, and the wings beat fast enough that the three
// poses read as a blur. Each one keeps a shadow on the water below it.
"use strict";

class Dragonfly {
  constructor(rand, res, index) {
    const D = CONFIG.dragonflies;
    this.index = index;
    this.variant = D.palettes[index % D.palettes.length];
    this.frames = [0, 1, 2].map((w) => TEXTURES.paintDragonfly(rand, this.variant, w));
    this.canvas = this.frames[0];
    this.rand = new Rand(CONFIG.seed ^ Math.imul(index + 31, 0x85ebca6b));

    this.anchor = this.pickAnchor(res, null);
    this.x = this.anchor.x;
    this.y = this.anchor.y;
    this.z = rand.range(0, 1);          // 0 is low over the water, 1 is high
    this.zTarget = this.z;
    this.heading = rand.angle();
    this.speed = rand.range(D.hoverSpeed[0], D.hoverSpeed[1]);
    this.phase = rand.angle();
    this.orbit = rand.range(1.6, 3.4);  // radius of the hover circle
    this.wingPhase = rand.angle();
    this.wingRate = rand.range(D.wingRate[0], D.wingRate[1]);
    this.state = "hover";
    this.timer = rand.range(D.hoverTime[0], D.hoverTime[1]);
    this.dartFrom = { x: this.x, y: this.y };
    this.dartT = 0;
    this.dartDur = 1;
    this.resting = false;
  }

  pickAnchor(res, away) {
    for (let i = 0; i < 24; i++) {
      const x = this.rand.range(res.x * 0.08, res.x * 0.92);
      const y = this.rand.range(res.y * 0.1, res.y * 0.88);
      if (away && Math.hypot(x - away.x, y - away.y) < 55) continue;
      return { x, y };
    }
    return { x: res.x * 0.5, y: res.y * 0.5 };
  }

  update(dt, time, res) {
    const D = CONFIG.dragonflies;
    this.timer -= dt;

    if (this.state === "hover" && this.timer <= 0) {
      // the next anchor is picked away from the current one, so a dart always
      // covers ground instead of twitching in place
      const next = this.pickAnchor(res, this.anchor);
      this.dartFrom = { x: this.x, y: this.y };
      this.dartTo = next;
      this.dartT = 0;
      this.dartDur = this.rand.range(D.dartTime[0], D.dartTime[1]);
      this.state = "dart";
      this.zTarget = this.rand.chance(D.lowSkim) ? this.rand.range(0.05, 0.3) : this.rand.range(0.55, 1);
      this.heading = Math.atan2(next.y - this.y, next.x - this.x);
    } else if (this.state === "dart") {
      this.dartT += dt / this.dartDur;
      if (this.dartT >= 1) {
        this.anchor = this.dartTo;
        this.state = "hover";
        this.timer = this.rand.range(D.hoverTime[0], D.hoverTime[1]);
        this.orbit = this.rand.range(1.6, 3.4);
        this.phase = this.rand.angle();
        this.zTarget = this.rand.chance(0.5) ? this.rand.range(0.45, 1) : this.rand.range(0.1, 0.4);
      }
    }

    if (this.state === "dart") {
      // straight line with a little ease at both ends: a dragonfly darts on
      // the spot and then hangs, it does not arc around
      const t = clamp(this.dartT, 0, 1);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const nx = this.dartFrom.x + (this.dartTo.x - this.dartFrom.x) * e;
      const ny = this.dartFrom.y + (this.dartTo.y - this.dartFrom.y) * e;
      const mvx = nx - this.x;
      const mvy = ny - this.y;
      const sp = Math.hypot(mvx, mvy) / Math.max(dt, 1e-4);
      if (sp > 0.5) this.heading = Math.atan2(mvy, mvx);
      this.x = nx;
      this.y = ny;
      this.speed = sp;
      // wings run flat out through a burst
      this.wingRate = Math.min(D.wingRate[1] * 1.35, this.wingRate);
    } else {
      // hover: a slow figure of eight, tightened so the insect holds station
      this.phase += dt * 1.5;
      const tx = this.anchor.x + Math.cos(this.phase * 2) * this.orbit * 0.5;
      const ty = this.anchor.y + Math.sin(this.phase) * this.orbit;
      const dx = tx - this.x;
      const dy = ty - this.y;
      const d = Math.hypot(dx, dy);
      const want = this.rand.range(D.hoverSpeed[0], D.hoverSpeed[1]);
      this.speed = approach(this.speed, want, 4, dt);
      if (d > 0.4) {
        const step = Math.min(d, this.speed * dt);
        this.x += (dx / d) * step;
        this.y += (dy / d) * step;
        // face into the drift, but keep the body level: a hovering dragonfly
        // holds its heading and slides sideways
        this.heading = angleToward(this.heading, Math.atan2(dy, dx), 2.2 * dt);
      }
      this.wingRate = approach(this.wingRate, this.rand.range(D.wingRate[0], D.wingRate[1]), 2, dt);
    }

    this.z = approach(this.z, this.zTarget, 1.6, dt);
    this.x = clamp(this.x, 6, res.x - 6);
    this.y = clamp(this.y, 6, res.y - 6);

    // wing beat: fast enough that the poses flicker, which is the blur
    this.wingPhase += dt * this.wingRate;
    const w = Math.abs(Math.sin(this.wingPhase));
    this.canvas = w < 0.34 ? this.frames[0] : w < 0.72 ? this.frames[1] : this.frames[2];
    this.rot = this.heading + Math.PI / 2;
    // near the top of its beat the body rides a little higher over the water
    this.hover = Math.sin(this.wingPhase * 0.5) * 0.4;
  }

  // how far the shadow sits below it: a high insect casts a wider, softer
  // shadow further from its body
  shadowGap() {
    return 2.2 + this.z * 4.2;
  }
}

function createDragonflies(rand, res) {
  const out = [];
  for (let i = 0; i < CONFIG.dragonflies.count; i++) {
    out.push(new Dragonfly(rand, res, i));
  }
  return out;
}

function updateDragonflies(dt, time, list, res) {
  for (const d of list) d.update(dt, time, res);
}
