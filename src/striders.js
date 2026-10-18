// Water striders. They stand on the surface film: rest, skate a few strokes,
// rest again, and scatter when something disturbs the water near them. Their
// shadow is four leg dimples, because the body never touches the water.
"use strict";

class Strider {
  constructor(rand, res, index) {
    this.rand = new Rand(CONFIG.seed ^ Math.imul(index + 71, 0x9e3779b1));
    this.frames = [TEXTURES.paintStrider(this.rand), TEXTURES.paintStrider(this.rand)];
    this.canvas = this.frames[0];
    this.x = this.rand.range(res.x * 0.1, res.x * 0.9);
    this.y = this.rand.range(res.y * 0.12, res.y * 0.88);
    this.heading = this.rand.angle();
    this.speed = 0;
    this.state = "rest";
    this.timer = this.rand.range(0.8, 2.6);
    this.strokes = 0;
    this.scare = 0;
    this.phase = this.rand.angle();
    this.rot = this.heading;
  }

  update(dt, time, ctx) {
    const { res, koi, count, rings } = ctx;
    this.phase += dt;

    // something nearby disturbs the film: a koi at the surface, a ring, a press
    let scared = false;
    for (let i = 0; i < count; i++) {
      const k = koi[i];
      if (k.depth > 0.35) continue;
      if (Math.hypot(k.x - this.x, k.y - this.y) < 26) { scared = true; break; }
    }
    if (!scared && rings) {
      for (const r of rings) {
        if (!r.alive || r.age <= 0 || r.amp < 0.25) continue;
        if (Math.hypot(r.x - this.x, r.y - this.y) < r.radius + 10) { scared = true; break; }
      }
    }
    if (scared && this.scare <= 0) {
      this.scare = 0.85;
      this.heading = Math.atan2(this.y - koi[0].y, this.x - koi[0].x) + this.rand.range(-0.5, 0.5);
      this.speed = this.rand.range(70, 110);
      this.state = "skate";
      this.strokes = 6;
      this.timer = 0.85;
    }
    if (this.scare > 0) this.scare -= dt;

    this.timer -= dt;
    if (this.timer <= 0) {
      if (this.state === "rest") {
        this.state = "skate";
        this.strokes = this.rand.int(3, 5);
        this.timer = this.rand.range(0.22, 0.45);
        this.heading += this.rand.range(-0.9, 0.9);
        this.speed = this.rand.range(34, 62);
      } else {
        this.state = "rest";
        this.timer = this.rand.range(0.7, 2.4);
        this.speed = 0;
      }
    }

    if (this.state === "skate") {
      // three quick strokes then a stall: speed is pulsed, not constant
      const pulse = 0.55 + 0.45 * Math.sin(this.phase * 26);
      const v = this.speed * pulse;
      const nx = this.x + Math.cos(this.heading) * v * dt;
      const ny = this.y + Math.sin(this.heading) * v * dt;
      this.x = clamp(nx, 8, res.x - 8);
      this.y = clamp(ny, 8, res.y - 8);
      this.heading += Math.sin(this.phase * 3.1) * dt * 1.4;
    }
    this.rot = this.heading;
  }
}

function createStriders(rand, res) {
  const out = [];
  for (let i = 0; i < CONFIG.striders.count; i++) out.push(new Strider(rand, res, i));
  return out;
}

function updateStriders(dt, time, list, ctx) {
  for (const s of list) s.update(dt, time, ctx);
}
