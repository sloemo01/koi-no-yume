// The fish. Each koi decides where to go from a handful of small urges, and
// its body follows its own head through a relaxed chain of spine nodes, so
// turns produce arcs and the tail follows through. Nothing is keyframed.
"use strict";

const SPINE_NODES = 14;
const MINNOW_NODES = 8;

// keep the pond visually varied: repeats get less likely, tancho stays rare
function pickKoiVariety(rand, tally) {
  const palettes = CONFIG.koi.palettes;
  let total = 0;
  const weights = palettes.map((v) => {
    const c = tally[v] || 0;
    if (v === "tancho" && c >= 1) return 0;
    const w = v === "tancho" ? 0.5 : 1;
    const eff = w / (1 + 2.2 * c);
    total += eff;
    return eff;
  });
  let r = rand.unit() * total;
  for (let i = 0; i < palettes.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      tally[palettes[i]] = (tally[palettes[i]] || 0) + 1;
      return palettes[i];
    }
  }
  const last = palettes[palettes.length - 1];
  tally[last] = (tally[last] || 0) + 1;
  return last;
}

class Koi {
  constructor(rand, pond, res, index, tally) {
    this.index = index;
    this.res = res;
    this.length = Math.round(rand.range(CONFIG.koi.length[0], CONFIG.koi.length[1]));
    this.height = Math.max(9, Math.round(this.length * 0.3));
    this.variety = pickKoiVariety(rand, tally);
    const sprite = TEXTURES.paintKoi(rand, this.variety, this.length);
    this.canvas = sprite.canvas;
    this.extents = sprite.extents;
    this.spineRow = sprite.spineRow;
    this.rand = new Rand(CONFIG.seed ^ Math.imul(index + 1, 0x85ebca6b));

    this.cruise = rand.range(CONFIG.koi.cruiseSpeed[0], CONFIG.koi.cruiseSpeed[1]);
    this.maxSpeed = this.cruise * rand.range(1.7, 2.1);
    this.turnRate = rand.range(CONFIG.koi.turnRate[0], CONFIG.koi.turnRate[1]);
    this.speedJitter = rand.range(0.82, 1.12);
    this.wanderSeed = rand.range(0, 120);
    this.waveAmpBase = rand.range(0.85, 1.2);
    this.reactivity = rand.range(0.4, 1);

    this.speed = this.cruise * rand.range(0.6, 0.95);
    this.angularVel = 0;
    this.state = "glide";
    this.stateTimer = rand.range(2, 7);
    this.tailEffort = 0.6;
    this.depth = rand.range(0.08, 0.5);
    this.depthTarget = this.depth;
    this.depthTimer = rand.range(3, 10);
    this.inDeep = false;
    this.fleeTimer = 0;
    this.fleeX = 0;
    this.fleeY = 0;
    this.callDelay = 0;
    this.responded = false;
    this.callAge = 0;
    this.gulpAnim = 0;
    this.gulpTimer = rand.range(3, 9);
    this.wakeClock = rand.range(0, 0.2);

    this.spine = [];
    for (let i = 0; i < SPINE_NODES; i++) this.spine.push({ x: 0, y: 0 });
    this.place(rand, pond);
  }

  place(rand, pond) {
    const p = pond.randomPoint(rand, 0.82, 0.15);
    this.x = p.x;
    this.y = p.y;
    this.heading = rand.angle();
    const spacing = this.length / (SPINE_NODES - 1);
    for (let i = 0; i < SPINE_NODES; i++) {
      this.spine[i].x = this.x - Math.cos(this.heading) * spacing * i;
      this.spine[i].y = this.y - Math.sin(this.heading) * spacing * i;
    }
  }

  enterState(next, roll) {
    this.state = next;
    switch (next) {
      case "glide": this.stateTimer = this.behaviorRange(1.8, 5.2); break;
      case "coast": this.stateTimer = this.behaviorRange(0.8, 2.2); break;
      case "hover": this.stateTimer = this.behaviorRange(0.7, 3.2); break;
      case "burst": this.stateTimer = this.behaviorRange(0.34, 0.9); break;
      case "pivot": {
        this.stateTimer = this.behaviorRange(0.3, 0.8);
        this.pivotHeading = wrapAngle(this.heading + this.behaviorSign() * this.behaviorRange(0.8, 2.3));
        break;
      }
    }
    this.startle = roll;
  }

  behaviorUnit() {
    let v = this.rand.unit();
    return v;
  }

  behaviorRange(lo, hi) {
    return lo + (hi - lo) * this.rand.unit();
  }

  behaviorSign() {
    return this.rand.unit() < 0.5 ? -1 : 1;
  }

  update(dt, world) {
    const { pond, time, call, koi, pellets } = world;
    let fx = 0;
    let fy = 0;
    let speedTarget = this.cruise * this.speedJitter;

    // wander: each fish carries its own slow, slightly irregular turn. A
    // spatial noise field would push whole neighbourhoods the same way and
    // the school would ride the shoreline; per-fish sines keep them roaming.
    const wander =
      Math.sin(time * 0.31 + this.wanderSeed) * 0.55 +
      Math.sin(time * 0.117 + this.wanderSeed * 1.73) * 0.4 +
      (valueNoise2(this.wanderSeed + this.x * 0.02, this.y * 0.02 + time * 0.05) - 0.5) * 0.9;
    fx += Math.cos(this.heading + wander) * 0.9;
    fy += Math.sin(this.heading + wander) * 0.9;

    // personal space, plus a loose pull toward the nearest company so the
    // school spreads through the middle of the pond instead of pressing
    // against the shoreline
    let cohX = 0;
    let cohY = 0;
    let neighbours = 0;
    for (const other of koi) {
      if (other === this) continue;
      const dx = this.x - other.x;
      const dy = this.y - other.y;
      const d = Math.hypot(dx, dy);
      if (d < 46 && d > 0.001) {
        neighbours++;
        cohX += other.x;
        cohY += other.y;
      }
      const minD = (this.length + other.length) * 0.22;
      if (d < minD && d > 1e-3) {
        const push = ((minD - d) / minD) * 2.2;
        fx += (dx / d) * push;
        fy += (dy / d) * push;
      }
    }
    if (neighbours > 0) {
      const toX = cohX / neighbours - this.x;
      const toY = cohY / neighbours - this.y;
      const len = Math.hypot(toX, toY) || 1;
      const w = clamp(len / 60, 0, 1) * 0.42;
      fx += (toX / len) * w;
      fy += (toY / len) * w;
    }

    // keep off the bank, and give the shoreline a wide berth
    const pd = pond.d(this.x, this.y);
    if (pd > 0.72) {
      const inward = pond.inward(this.x, this.y);
      const push = (pd - 0.72) * 13;
      fx += inward.x * push;
      fy += inward.y * push;
      if (pd > 0.95) {
        const f = 0.95 / pd;
        this.x = pond.cx + (this.x - pond.cx) * f;
        this.y = pond.cy + (this.y - pond.cy) * f;
      }
    }

    // food: pellets win over everything else
    let pellet = null;
    let pelletD = 1e9;
    for (const p of pellets) {
      if (p.eaten) continue;
      const d = Math.hypot(p.x - this.x, p.y - this.y);
      if (d < 90 && d < pelletD) {
        pelletD = d;
        pellet = p;
      }
    }
    if (pellet) {
      const d = Math.max(0.001, pelletD);
      fx += ((pellet.x - this.x) / d) * 2.4;
      fy += ((pellet.y - this.y) / d) * 2.4;
      speedTarget = Math.max(speedTarget, this.cruise * 1.5);
      this.depthTarget = 0.08;
      if (d < this.length * 0.32 && this.gulpAnim <= 0) {
        pellet.eaten = true;
        this.gulpAnim = 0.4;
        this.gulpTimer = this.behaviorRange(3, 8);
        spawnRipple("mouth", this.x + Math.cos(this.heading) * this.height * 0.4,
          this.y + Math.sin(this.heading) * this.height * 0.4, { scale: 0.9 });
        world.onGulp && world.onGulp(this);
      }
    }

    // a scatter is felt for a moment
    if (this.fleeTimer > 0) {
      this.fleeTimer -= dt;
      fx += this.fleeX * 2.8;
      fy += this.fleeY * 2.8;
      speedTarget = this.maxSpeed * 0.92;
    }

    // a click is an invitation: each fish waits its own moment, then bursts
    // and comes over to look
    this.callDelay = Math.max(0, this.callDelay - dt);
    const callLive = call && call.age < call.duration;
    if (callLive) {
      if (!this.responded && this.callDelay <= 0) {
        this.responded = true;
        this.depthTarget = 0.1;
      }
      if (this.responded) {
        const dx = call.x - this.x;
        const dy = call.y - this.y;
        const d = Math.hypot(dx, dy) || 1;
        const weight = 1.1 + (1 - clamp(d / call.radius, 0, 1)) * 1.6;
        if (d > this.length * 1.1) {
          fx += (dx / d) * weight;
          fy += (dy / d) * weight;
        } else {
          // close enough: circle the spot instead of stacking up on it
          const side = this.index % 2 === 0 ? 1 : -1;
          fx += (-dy / d) * side * 1.5 + (dx / d) * -0.4;
          fy += (dx / d) * side * 1.5 + (dy / d) * -0.4;
        }
        this.depthTarget = 0.1;
        // turn first, then charge: swimming hard while still pointed the
        // wrong way just throws the fish outward
        const pointing = Math.abs(wrapAngle(Math.atan2(dy, dx) - this.heading)) < 0.7;
        speedTarget = Math.max(speedTarget, this.maxSpeed * (pointing ? 0.95 : 0.5));
      }
    } else {
      this.responded = false;
    }

    // moods
    this.stateTimer -= dt;
    if (this.stateTimer <= 0) {
      const roll = this.rand.unit();
      switch (this.state) {
        case "glide":
          if (roll < 0.3) this.enterState("coast", roll);
          else if (roll < 0.48) this.enterState("hover", roll);
          else if (roll < 0.68) this.enterState("pivot", roll);
          else if (roll < 0.78) this.enterState("burst", roll);
          else this.enterState("glide", roll);
          break;
        case "coast":
          if (roll < 0.4) this.enterState("glide", roll);
          else if (roll < 0.68) this.enterState("hover", roll);
          else if (roll < 0.86) this.enterState("pivot", roll);
          else this.enterState("burst", roll);
          break;
        case "hover":
          if (roll < 0.36) this.enterState("glide", roll);
          else if (roll < 0.6) this.enterState("pivot", roll);
          else this.enterState("burst", roll);
          break;
        case "burst":
          this.enterState("coast", roll);
          break;
        default:
          this.enterState(roll < 0.4 ? "glide" : "burst", roll);
          break;
      }
    }
    switch (this.state) {
      case "hover": speedTarget = Math.min(speedTarget, 2.4); break;
      case "coast": speedTarget *= 0.42; break;
      case "burst": speedTarget = Math.max(speedTarget, this.maxSpeed * 1.02); break;
      case "pivot": speedTarget *= 0.4; break;
      default: break;
    }

    // steer with inertia: the heading chases the desired one through
    // angular velocity, so pivots ease in and out
    let desired = Math.atan2(fy, fx);
    if (this.state === "pivot") {
      desired = wrapAngle(desired + this.behaviorSign() * 1.0);
      // blend toward the pivot heading instead of snapping
      const mix = 0.5;
      desired = wrapAngle(this.pivotHeading * mix + desired * (1 - mix));
    }
    const err = wrapAngle(desired - this.heading);
    const damping = this.state === "pivot" ? 3.0 : 4.2;
    const accel = err * this.turnRate * (this.state === "pivot" ? 1.8 : 1) - this.angularVel * damping;
    this.angularVel += accel * dt;
    // a fish cannot turn tighter than its own body allows, or the spine folds
    // back on itself and the sprite reads as a bent banana. Answering a call
    // buys a tighter arc.
    const eager = callLive && this.responded;
    const maxTurn = clamp(this.speed / (this.length * (eager ? 0.34 : 0.55)), 0.12, 3.0);
    this.angularVel = clamp(this.angularVel, -maxTurn, maxTurn);
    this.heading = wrapAngle(this.heading + this.angularVel * dt);

    const speedResponse = this.state === "burst" ? 5.2 : this.state === "pivot" ? 4.0 : 1.7;
    this.speed = clamp(
      approach(this.speed, speedTarget, speedResponse, dt),
      0.35,
      this.maxSpeed * 1.35,
    );
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;

    // depth drifts between the surface and the cool of the middle
    const rising = call && call.age < call.duration && this.depth > 0.12;
    this.depthTimer -= dt;
    if (this.depthTimer <= 0 && !rising) {
      if (this.rand.chance(0.6)) this.inDeep = !this.inDeep;
      this.depthTarget = this.inDeep
        ? this.behaviorRange(0.42, 0.78)
        : this.behaviorRange(0.05, 0.24);
      this.depthTimer = this.behaviorRange(4, 13);
    }
    this.depth = clamp(approach(this.depth, this.depthTarget, 0.9, dt), 0.02, 0.85);

    // tail effort: how hard the body is working
    const wanted = this.state === "burst" ? 1.2 : this.state === "hover" ? 0.15 : this.state === "coast" ? 0.35 : 0.65;
    this.tailEffort = approach(this.tailEffort, wanted, 4.5, dt);
    const beat = 0.5 + (this.speed / this.maxSpeed) * 4.4 + this.tailEffort * 0.9;
    this.wavePhase = (this.wavePhase || 0) + beat * dt;
    this.gulpAnim = Math.max(0, this.gulpAnim - dt);

    // gulp at the surface now and then when calm
    this.gulpTimer -= dt;
    if (this.gulpTimer <= 0) {
      const calm = this.state === "glide" || this.state === "coast" || this.state === "hover";
      if (calm && this.depth < 0.35 && this.speed < this.cruise) {
        this.gulpAnim = 0.4;
        spawnRipple("mouth",
          this.x + Math.cos(this.heading) * this.height * 0.42,
          this.y + Math.sin(this.heading) * this.height * 0.42, {});
        world.onGulp && world.onGulp(this);
      }
      this.gulpTimer = this.behaviorRange(4, 12);
    }

    // a soft wake when swimming fast and near the surface
    if (this.depth < 0.3 && this.speed > this.cruise * 1.2) {
      this.wakeClock -= dt;
      if (this.wakeClock <= 0) {
        this.wakeClock = this.behaviorRange(0.35, 0.7);
        spawnRipple("wake", this.x - Math.cos(this.heading) * this.length * 0.5,
          this.y - Math.sin(this.heading) * this.length * 0.5, { scale: 0.5 });
      }
    } else {
      this.wakeClock = Math.max(this.wakeClock, 0.15);
    }

    // the body: each node keeps its distance from the one in front, and the
    // tail lags a little more than the shoulders, which is the follow-through
    const spacing = (this.length / (SPINE_NODES - 1)) * 1.08;
    this.spine[0].x = this.x;
    this.spine[0].y = this.y;
    const bx = -Math.cos(this.heading);
    const by = -Math.sin(this.heading);
    for (let i = 1; i < SPINE_NODES; i++) {
      const node = this.spine[i];
      const prev = this.spine[i - 1];
      let dx = node.x - prev.x;
      let dy = node.y - prev.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-4) {
        dx = bx;
        dy = by;
      } else {
        dx = (dx / len) * spacing;
        dy = (dy / len) * spacing;
      }
      const tx = prev.x + dx;
      const ty = prev.y + dy;
      const tail = i / (SPINE_NODES - 1);
      const stiffness = 0.97 - tail * 0.15;
      node.x = lerp(node.x, tx, stiffness);
      node.y = lerp(node.y, ty, stiffness);
    }
  }

  scatter(rand, pond) {
    const away = Math.atan2(this.y - pond.cy, this.x - pond.cx) + rand.range(-0.8, 0.8);
    this.fleeX = Math.cos(away);
    this.fleeY = Math.sin(away);
    this.fleeTimer = rand.range(0.9, 1.6);
    this.enterState("burst", 1);
    this.depthTarget = this.behaviorRange(0.1, 0.35);
  }

  depthScale() {
    return 1 - this.depth * 0.06;
  }
}

class MinnowSchool {
  constructor(rand, pond, res, index) {
    this.index = index;
    this.rand = new Rand(CONFIG.seed ^ Math.imul(index + 7, 0x27d4eb2f));
    const home = pond.randomPoint(rand, 0.78, 0.15);
    this.x = home.x;
    this.y = home.y;
    this.heading = rand.angle();
    this.speed = CONFIG.minnows.cruiseSpeed;
    this.state = "cruise";
    this.timer = rand.range(1.4, 4);
    this.targetX = this.x;
    this.targetY = this.y;
    this.wakeClock = 0;

    const variants = ["silver", "slate", "gold", "ember"];
    this.fish = [];
    const count = rand.int(CONFIG.minnows.perSchool[0], CONFIG.minnows.perSchool[1]);
    for (let i = 0; i < count; i++) {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const rows = Math.ceil(count / 3);
      const sprite = TEXTURES.paintMinnow(rand, rand.pick(variants));
      this.fish.push({
        sprite,
        canvas: sprite.canvas,
        extents: sprite.extents,
        ox: -col * 13 + 8 + rand.range(-3, 3),
        oy: (row - (rows - 1) / 2) * 10 + rand.range(-3, 3),
        x: this.x + rand.range(-10, 10),
        y: this.y + rand.range(-10, 10),
        heading: rand.angle(),
        speed: rand.range(8, 14),
        jitter: rand.range(0, 60),
        phase: rand.angle(),
        spine: [],
      });
    }
    for (const m of this.fish) {
      for (let i = 0; i < MINNOW_NODES; i++) m.spine.push({ x: m.x, y: m.y });
    }
  }

  update(dt, world) {
    const { pond, time, koi, pellets } = world;
    this.timer -= dt;

    // threats: koi overhead, fresh rings, food splashing down
    let threatX = 0;
    let threatY = 0;
    let threat = 0;
    for (const k of koi) {
      const dx = this.x - k.x;
      const dy = this.y - k.y;
      const d = Math.hypot(dx, dy);
      const radius = CONFIG.minnows.fleeRadius + k.length * 0.5;
      if (d < radius && d > 0.001) {
        const w = (radius - d) / radius;
        threatX += (dx / d) * w;
        threatY += (dy / d) * w;
        threat = Math.max(threat, w);
      }
    }
    for (const ring of WATER_FIELD.rings) {
      if (!ring.alive || ring.age <= 0 || ring.amp < 0.2) continue;
      const dx = this.x - ring.x;
      const dy = this.y - ring.y;
      const d = Math.hypot(dx, dy);
      if (d < ring.radius + 26 && d > 0.001) {
        const w = 0.7;
        threatX += (dx / d) * w;
        threatY += (dy / d) * w;
        threat = Math.max(threat, w);
      }
    }

    if (this.timer <= 0) {
      if (this.state === "cruise" && (threat > 0.15 || this.rand.chance(0.4))) {
        this.state = "dart";
        this.timer = this.rand.range(0.5, 1.1);
        let tx;
        let ty;
        if (threat > 0.15) {
          const away = Math.atan2(threatY, threatX);
          const p = pond.randomPoint(this.rand, 0.8, 0.2);
          tx = (this.x + Math.cos(away) * 120) * 0.6 + p.x * 0.4;
          ty = (this.y + Math.sin(away) * 120) * 0.6 + p.y * 0.4;
        } else {
          const p = pond.randomPoint(this.rand, 0.8, 0.2);
          tx = p.x;
          ty = p.y;
        }
        this.targetX = clamp(tx, 10, world.res.x - 10);
        this.targetY = clamp(ty, 10, world.res.y - 10);
      } else {
        this.state = "cruise";
        this.timer = this.rand.range(2.5, 6);
      }
    }

    let desired;
    if (this.state === "dart") {
      desired = Math.atan2(this.targetY - this.y, this.targetX - this.x);
    } else {
      desired = this.heading + (valueNoise2(this.x * 0.01, this.y * 0.01 + time * 0.06) - 0.5) * 1.1;
    }
    this.heading = angleToward(this.heading, desired, (this.state === "dart" ? 6.5 : 2.2) * dt);
    const targetSpeed = this.state === "dart" ? CONFIG.minnows.dartSpeed : CONFIG.minnows.cruiseSpeed;
    this.speed = approach(this.speed, targetSpeed, this.state === "dart" ? 6 : 2.2, dt);
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;

    const pd = pond.d(this.x, this.y);
    if (pd > 0.8) {
      const inward = pond.inward(this.x, this.y);
      const push = (pd - 0.8) * 10;
      this.heading = Math.atan2(
        Math.sin(this.heading) + inward.y * push * dt * 6,
        Math.cos(this.heading) + inward.x * push * dt * 6,
      );
      if (pd > 0.88) {
        const f = 0.88 / pd;
        this.x = pond.cx + (this.x - pond.cx) * f;
        this.y = pond.cy + (this.y - pond.cy) * f;
        this.state = "cruise";
        this.timer = this.rand.range(1, 3);
      }
    }

    // the school keeps its heading; slots only lean the nose, or every
    // member points somewhere different and the school reads as debris
    for (const m of this.fish) {
      const wob = Math.sin(time * 0.9 + m.jitter) * 3;
      const wob2 = Math.cos(time * 0.8 + m.jitter * 1.3) * 2.4;
      const tx = this.x + m.ox + wob;
      const ty = this.y + m.oy + wob2;
      const dx = tx - m.x;
      const dy = ty - m.y;
      const slotAngle = Math.atan2(dy, dx);
      let lean = wrapAngle(slotAngle - m.heading);
      lean = clamp(lean, -0.9, 0.9) * 0.45;
      m.heading = angleToward(m.heading, wrapAngle(m.heading + lean), 6 * dt);
      const far = Math.min(Math.hypot(dx, dy) * 0.9, 26);
      const wanted = clamp(this.speed * (this.state === "dart" ? 1.35 : 1) + far * 0.7, 4, 78);
      m.speed = approach(m.speed, wanted, 5, dt);
      m.x += Math.cos(m.heading) * m.speed * dt;
      m.y += Math.sin(m.heading) * m.speed * dt;
      m.phase += dt * (7 + m.speed * 0.12);

      for (let i = 0; i < MINNOW_NODES; i++) {
        const t = i / (MINNOW_NODES - 1);
        const node = m.spine[i];
        node.x = m.x - Math.cos(m.heading) * (CONFIG.minnows.length / (MINNOW_NODES - 1)) * i;
        node.y = m.y - Math.sin(m.heading) * (CONFIG.minnows.length / (MINNOW_NODES - 1)) * i;
        void t;
      }
    }

    // a wake while the school bolts
    if (this.state === "dart") {
      this.wakeClock -= dt;
      if (this.wakeClock <= 0) {
        this.wakeClock = this.rand.range(0.4, 0.8);
        spawnRipple("wake", this.x, this.y, { scale: 0.45 });
      }
    }
    void pellets;
  }
}

function createSchool(rand, pond, res) {
  const tally = {};
  const koi = [];
  for (let i = 0; i < CONFIG.koi.maxCount; i++) {
    koi.push(new Koi(new Rand(CONFIG.seed ^ Math.imul(i + 1, 0x51ed270b)), pond, res, i, tally));
  }
  const minnows = [];
  for (let i = 0; i < CONFIG.minnows.schools; i++) {
    minnows.push(new MinnowSchool(new Rand(CONFIG.seed ^ Math.imul(i + 3, 0x9e3779b1)), pond, res, i));
  }
  return { koi, minnows, tally };
}
