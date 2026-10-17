// Butterflies: four small states — wander the pond, approach a flower,
// circle it, land on it — with a curved flight path so they never move in a
// straight line. Flapping is a three-frame swap; resting folds the wings.
"use strict";

class Butterfly {
  constructor(rand, res, index) {
    const B = CONFIG.butterflies;
    this.palette = B.palettes[index % B.palettes.length];
    this.frames = [
      TEXTURES.paintButterfly(rand, this.palette, 0),
      TEXTURES.paintButterfly(rand, this.palette, 0.55),
      TEXTURES.paintButterfly(rand, this.palette, 1),
    ];
    this.restCanvas = TEXTURES.paintButterflyRest(rand, this.palette);
    this.canvas = this.frames[2];
    this.resting = false;

    this.x = rand.range(res.x * 0.2, res.x * 0.8);
    this.y = rand.range(res.y * 0.2, res.y * 0.75);
    this.heading = rand.angle();
    this.speed = rand.range(B.cruiseSpeed[0], B.cruiseSpeed[1]);
    this.cruise = this.speed;
    this.phase = rand.angle();
    this.flapSpeed = rand.range(B.flapSpeed[0], B.flapSpeed[1]);
    this.flapPhase = rand.angle();
    this.curveFreq = rand.range(0.7, 1.3);
    this.turnTarget = rand.range(-0.6, 0.6);
    this.turnTimer = rand.range(0.6, 1.6);
    this.turn = 0;
    this.drift = rand.range(0.6, 1.5);
    this.state = "wander";
    this.timer = rand.range(B.wanderDuration[0], B.wanderDuration[1]);
    this.target = { x: this.x, y: this.y };
    this.flowerIndex = 0;
    this.orbitRadius = 7;
    this.orbitDirection = index % 2 === 0 ? 1 : -1;
    this.rot = this.heading + Math.PI / 2;
    this.rand = new Rand(CONFIG.seed ^ Math.imul(index + 11, 0x27d4eb2f));
  }

  pickWanderTarget(res) {
    const a = this.heading + this.rand.range(-0.9, 0.9);
    const d = this.rand.range(40, 95);
    this.target.x = clamp(this.x + Math.cos(a) * d, 12, res.x - 12);
    this.target.y = clamp(this.y + Math.sin(a) * d, 12, res.y - 12);
  }

  update(dt, time, ctx) {
    const B = CONFIG.butterflies;
    const { res, flowers } = ctx;
    this.timer -= dt;
    if (this.timer <= 0) {
      if (this.state === "wander") {
        if (flowers.length && this.rand.chance(B.visitChance)) {
          this.state = "approach";
          this.timer = 9;
          this.flowerIndex = Math.floor(this.rand.unit() * flowers.length);
        } else {
          this.state = "wander";
          this.timer = this.rand.range(B.wanderDuration[0], B.wanderDuration[1]);
          this.pickWanderTarget(res);
        }
      } else if (this.state === "approach") {
        this.state = "wander";
        this.timer = this.rand.range(B.wanderDuration[0], B.wanderDuration[1]);
        this.pickWanderTarget(res);
      } else if (this.state === "orbit") {
        this.state = "rest";
        this.resting = true;
        this.timer = this.rand.range(B.restDuration[0], B.restDuration[1]);
        this.restOffset = { x: this.rand.range(-2.5, 2.5), y: this.rand.range(-2.5, 2.5) };
      } else {
        this.state = "wander";
        this.resting = false;
        this.timer = this.rand.range(B.wanderDuration[0], B.wanderDuration[1]);
        this.pickWanderTarget(res);
      }
    }

    let target = this.target;
    let speedTarget = this.cruise;
    if (this.state === "approach" && flowers.length) {
      const f = flowers[Math.min(this.flowerIndex, flowers.length - 1)];
      target = { x: f.x, y: f.y };
      speedTarget = this.cruise * 0.85;
      if (Math.hypot(this.x - f.x, this.y - f.y) < 9) {
        this.state = "orbit";
        this.timer = this.rand.range(B.orbitDuration[0], B.orbitDuration[1]);
        this.orbitRadius = this.rand.range(6, 11);
        this.orbitAngle = Math.atan2(this.y - f.y, this.x - f.x);
      }
    } else if (this.state === "orbit" && flowers.length) {
      const f = flowers[Math.min(this.flowerIndex, flowers.length - 1)];
      this.orbitAngle += dt * 1.6 * this.orbitDirection * (7 / this.orbitRadius);
      target = {
        x: f.x + Math.cos(this.orbitAngle) * this.orbitRadius,
        y: f.y + Math.sin(this.orbitAngle) * this.orbitRadius,
      };
      speedTarget = this.cruise * 0.7;
    } else if (this.state === "rest" && flowers.length) {
      const f = flowers[Math.min(this.flowerIndex, flowers.length - 1)];
      target = { x: f.x + this.restOffset.x, y: f.y + this.restOffset.y };
      speedTarget = this.cruise * 0.12;
    } else if (Math.hypot(this.x - target.x, this.y - target.y) < 12) {
      this.pickWanderTarget(res);
      target = this.target;
    }

    const turnScale = this.state === "wander" ? 1 : this.state === "approach" ? 0.35 : this.state === "orbit" ? 0.12 : 0;
    this.turnTimer -= dt;
    if (this.turnTimer <= 0) {
      this.turnTimer = this.rand.range(0.5, 1.8);
      this.turnTarget = (this.rand.unit() * 2 - 1) * (this.rand.chance(0.25) ? 0.9 : 0.35);
    }
    this.turn = approach(this.turn, this.turnTarget, 5, dt);

    const desired = Math.atan2(target.y - this.y, target.x - this.x);
    const curve =
      (Math.sin(time * this.curveFreq + this.phase) + Math.sin(time * this.curveFreq * 2.17 + this.phase * 2.3) * 0.38) * 0.34 * turnScale;
    const heading = desired + (this.turn + curve) * turnScale;
    this.heading = angleToward(this.heading, heading, 4.5 * dt);
    this.speed = approach(this.speed, speedTarget, 3.2, dt);
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;

    const margin = 10;
    if (this.x < margin || this.x > res.x - margin) {
      this.x = clamp(this.x, margin, res.x - margin);
      this.heading = Math.PI - this.heading;
      this.pickWanderTarget(res);
    }
    if (this.y < margin || this.y > res.y - margin) {
      this.y = clamp(this.y, margin, res.y - margin);
      this.heading = -this.heading;
      this.pickWanderTarget(res);
    }

    // sprite frame: three spreads plus a folded rest pose
    this.flapPhase += dt * this.flapSpeed * (this.resting ? 0.25 : 1);
    const flap = Math.abs(Math.sin(this.flapPhase));
    this.canvas = flap < 0.34 ? this.frames[0] : flap < 0.67 ? this.frames[1] : this.frames[2];
    if (this.resting) this.canvas = this.restCanvas;
    this.rot = this.heading + Math.PI / 2 + (this.resting ? this.rand.range(-0.2, 0.2) : 0);
  }
}

function createButterflies(rand, res) {
  const out = [];
  for (let i = 0; i < CONFIG.butterflies.count; i++) {
    out.push(new Butterfly(rand, res, i));
  }
  return out;
}

function updateButterflies(dt, time, list, ctx) {
  for (const b of list) b.update(dt, time, ctx);
}
