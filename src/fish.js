// The fish. Each koi decides where to go from a handful of small urges, and
// its body follows its own head through a relaxed chain of spine nodes, so
// turns produce arcs and the tail follows through. Nothing is keyframed.
"use strict";

const SPINE_NODES = 14;
const MINNOW_NODES = 8;

// A fish can bend, but it cannot fold flat against itself. Without this the
// spine could double back on a hard U-turn, and the renderer's tail test then
// cut through the middle of the body: the fish vanished mid-turn. Clamping the
// angle between consecutive segments keeps the hull a hull.
function limitSpineBend(spine, maxStep) {
  try {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < spine.length - 1; i++) {
        const a = spine[i - 1];
        const b = spine[i];
        const c = spine[i + 1];
        const a1 = Math.atan2(b.y - a.y, b.x - a.x);
        const a2 = Math.atan2(c.y - b.y, c.x - b.x);
        let d = wrapAngle(a2 - a1);
        if (Math.abs(d) <= maxStep) continue;
        const want = a1 + Math.sign(d) * maxStep;
        const len = Math.hypot(c.x - b.x, c.y - b.y) || 1;
        c.x = b.x + Math.cos(want) * len;
        c.y = b.y + Math.sin(want) * len;
      }
    }
  } catch (e) {
    // a malformed chain is not worth losing the frame over
  }
}

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
  constructor(rand, pond, res, index, tally, opts) {
    const small = !!(opts && opts.small);
    this.index = index;
    this.res = res;
    this.small = small;
    const sizeMul = small ? CONFIG.koi.smallLength : 1;
    this.length = Math.max(10, Math.round(rand.range(CONFIG.koi.length[0], CONFIG.koi.length[1]) * sizeMul * (CONFIG.koi.sizeScale || 1)));
    this.variety = small ? "orange"
      : (opts && opts.variety ? opts.variety : pickKoiVariety(rand, tally));
    const sprite = TEXTURES.paintKoi(rand, this.variety, this.length);
    this.canvas = sprite.canvas;
    this.extents = sprite.extents;
    this.spineRow = sprite.spineRow;
    this.height = sprite.height;
    this.rand = new Rand(CONFIG.seed ^ Math.imul(index + 1, 0x85ebca6b));

    this.cruise = rand.range(CONFIG.koi.cruiseSpeed[0], CONFIG.koi.cruiseSpeed[1]) * (small ? 1.25 : 1);
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
    this.depth = rand.range(0.06, 0.24);
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
    // what the renderer samples: x, y, arclength for every spine node
    this.spineData = new Float32Array(SPINE_NODES * 4);
    this.aabb = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    this.spineTex = null;
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
    const { pond, time, call, koi, pellets, stones } = world;
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

    // Stones are handled where the heading is chosen, not as a force: a push
    // balanced against the wander and left koi stalled against a stone. See
    // the desired-heading block below.

    // stay inside the frame: the pond runs past every edge, but a fish that
    // swims out of the view is simply gone
    const m = 26;
    const res = world.res;
    if (this.x < m) fx += ((m - this.x) / m) * 5.5;
    if (this.x > res.x - m) fx -= ((this.x - (res.x - m)) / m) * 5.5;
    if (this.y < m) fy += ((m - this.y) / m) * 5.5;
    if (this.y > res.y - m) fy -= ((this.y - (res.y - m)) / m) * 5.5;
    this.x = clamp(this.x, 6, res.x - 6);
    this.y = clamp(this.y, 6, res.y - 6);

    // A fish pressed on the frame edge can sit there for a long time: the push
    // inward is cancelled by whatever it is swimming toward, and the turn rate
    // at cruise is a third of a radian a second, so it cannot come off the
    // boundary once its nose is in it. If the body has barely moved while it
    // should be swimming, turn it toward open water and get it going again.
    this.prevX = this.x;
    this.prevY = this.y;
    // A fish can be swimming at full speed and still be trapped: it circles
    // inside a pocket of stones, never getting out. So the test is progress,
    // not motion. Every 1.4 s, if it has not got anywhere and there is a stone
    // within a body length or so, it takes the most open way out and holds it.
    this.progressTimer = (this.progressTimer || 0) + dt;
    if (this.progressTimer > 1.4) {
      const ax0 = this.anchorX !== undefined ? this.anchorX : this.x;
      const ay0 = this.anchorY !== undefined ? this.anchorY : this.y;
      const drift = Math.hypot(this.x - ax0, this.y - ay0);
      let nearStone = false;
      if (stones) {
        for (const st of stones) {
          if (Math.hypot(st.x - this.x, st.y - this.y) < st.w * 0.5 + this.height * 1.7) { nearStone = true; break; }
        }
      }
      if (nearStone && drift < 26 && this.speed > 2.5 && this.state !== "hover") {
        this.escapeHeading = openDirection(this, stones, res, 60);
        this.escapeTimer = 1.1;
        this.heading = this.escapeHeading;
        this.angularVel = 0;
        this.speed = Math.max(this.speed, this.cruise);
      }
      this.anchorX = this.x;
      this.anchorY = this.y;
      this.progressTimer = 0;
    }
    if (this.escapeTimer > 0) this.escapeTimer -= dt;

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
        if (Math.random() < CONFIG.bubbles.fishChance) {
          spawnBubbles(this.x, this.y, 2, 9);
        }
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
    const C = CONFIG.callResponse;
    if (callLive) {
      if (!this.responded && this.callDelay <= 0) {
        this.responded = true;
        this.callResponseAge = 0;
        this.depthTarget = 0.1;
        this.enterState("burst", 0.5);
      }
      if (this.responded) {
        this.callResponseAge = (this.callResponseAge || 0) + dt;
        const dx = call.x - this.x;
        const dy = call.y - this.y;
        const d = Math.hypot(dx, dy) || 1;
        // One slot on one of three rings round the press. The slot moves with
        // the ring, so a fish that reaches it simply swims round; nothing
        // chases a point that has already gone, and the ring keeps its shape
        // however many times you press.
        const band = this.callBand || 0;
        const ring = (call.ringBase || 46) + band * (call.ringStep || 30);
        const slots = Math.max(1, (call.slotsInBand && call.slotsInBand[band]) || 1);
        const slotAng = (call.phase || 0) + ((this.callSlot || 0) / slots) * Math.PI * 2 + band * 0.45;
        const tx = call.x + Math.cos(slotAng) * ring;
        const ty = call.y + Math.sin(slotAng) * ring;
        const tdx = tx - this.x;
        const tdy = ty - this.y;
        const td = Math.hypot(tdx, tdy) || 1;
        fx += (tdx / td) * 2.9;
        fy += (tdy / td) * 2.9;
        // hold the ring, and never cut inside it
        const radial = clamp((d - ring) * 0.16, -3.0, 3.0);
        fx += (dx / d) * radial;
        fy += (dy / d) * radial;
        if (d < ring * 0.75) {
          fx += (dx / d) * 3.6;
          fy += (dy / d) * 3.6;
        }
        // a sprint to get there, then a steady turn
        if (this.callResponseAge < C.chaseBoostSeconds) {
          const e = 1 - clamp(this.callResponseAge / C.chaseBoostSeconds, 0, 1);
          speedTarget = Math.max(speedTarget, this.maxSpeed * (C.chaseSpeedMultiplier + e * C.initialExtraSpeedMultiplier));
        } else {
          speedTarget = Math.max(speedTarget, ring * (call.spin || 0.35) * 1.25);
        }
        this.depthTarget = 0.1;
      }
    } else {
      this.responded = false;
      this.callResponseAge = 0;
      this.callRing = undefined;
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
    // A stone that is ahead bends the course along its edge. Steering the
    // heading is what makes fish thread the gaps: a force away from the stone
    // simply cancelled the wander and the fish sat against it for ever, which
    // is the koi that looked stuck in the bottom corner. Only the nearest stone
    // ahead gets a say, because two tangents from a pair of stones cancel and
    // leave the fish turning on the spot.
    if (stones && !(this.escapeTimer > 0)) {
      let bestSt = null;
      let bestDist = 1e9;
      for (const st of stones) {
        const dist = Math.hypot(st.x - this.x, st.y - this.y) || 1;
        // clearance is body width, not body length: padding by half a 60 px koi
        // closed a corridor the fish could actually have swum through
        const reach = st.w * 0.5 + this.height * 0.9 + 6;
        if (dist > reach) continue;
        const nx0 = (st.x - this.x) / dist;
        const ny0 = (st.y - this.y) / dist;
        if (Math.abs(wrapAngle(Math.atan2(ny0, nx0) - this.heading)) > 1.45) continue;
        if (dist < bestDist) { bestDist = dist; bestSt = st; }
      }
      if (bestSt) {
        const dist = bestDist;
        const nx = (bestSt.x - this.x) / dist;
        const ny = (bestSt.y - this.y) / dist;
        const cross = Math.cos(this.heading) * ny - Math.sin(this.heading) * nx;
        const lean = cross >= 0 ? 1 : -1;
        // Two ways round the stone. Take the one that leads into open water:
        // beside the frame edge, the outward way walks straight into the edge
        // push and the two balance to a stop, which is the corner trap the
        // stones used to make. Room ahead decides, with a nudge for the side
        // the fish is already leaning to so it does not dither.
        let bestSide = lean;
        let bestRoom = -1e9;
        for (const sgn of [lean, -lean]) {
          const tx = nx * sgn;
          const ty = -ny * sgn;
          const ax = this.x + tx * 30;
          const ay = this.y + ty * 30;
          let room = Math.min(ax, res.x - ax, ay, res.y - ay);
          if (sgn === lean) room += 12;
          if (room > bestRoom) { bestRoom = room; bestSide = sgn; }
        }
        const tangent = Math.atan2(nx * bestSide, -ny * bestSide);
        const close = 1 - dist / (bestSt.w * 0.5 + this.height * 0.9 + 6);
        desired = wrapAngle(desired + wrapAngle(tangent - desired) * Math.min(0.92, close * 1.7));
      }
    }
    // a fish coming out of a pocket holds the open direction and swims it out
    if (this.escapeTimer > 0 && this.escapeHeading !== undefined) {
      desired = this.escapeHeading;
      speedTarget = Math.max(speedTarget, this.cruise * 1.15);
    }
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
    if (stones) {
      const touched = resolveStones(stones, this, this.height * 0.55);
      if (touched && !(this.escapeTimer > 0)) {
        // Touching a stone turns the fish along its face straight away. The
        // heading normally chases the desired course at a rate set by body
        // length, which for a 60 px koi is about a third of a radian a second:
        // too slow to come off a stone it has already reached, so it used to
        // sit there with its nose in the rock.
        const nx = (touched.x - this.x) || 1;
        const ny = (touched.y - this.y) || 0;
        const len = Math.hypot(nx, ny) || 1;
        const tx = -ny / len;
        const ty = nx / len;
        const a = Math.atan2(ty, tx);
        const b = wrapAngle(a + Math.PI);
        const dax = Math.abs(wrapAngle(a - this.heading));
        const dbx = Math.abs(wrapAngle(b - this.heading));
        this.heading = dax <= dbx ? a : b;
      }
    }

    // A call is an invitation to the surface: for as long as it lasts nobody
    // dives, and anyone already down comes up. Without the hold they surfaced,
    // then the depth timer dropped them again halfway through the circle.
    const called = !!(call && call.active && call.age < call.duration && !this.small);
    if (called) {
      this.inDeep = false;
      this.depthTarget = Math.min(this.depthTarget, 0.1);
      this.depthTimer = Math.max(this.depthTimer, 4);
    }
    const rising = called && this.depth > 0.12;
    this.depthTimer -= dt;
    if (this.depthTimer <= 0 && !rising && !called) {
      // a dive is an event, not a lifestyle: most of the time they stay up
      if (this.inDeep) {
        this.inDeep = false;
      } else if (this.rand.chance(0.3)) {
        this.inDeep = true;
      }
      this.depthTarget = this.inDeep
        ? this.behaviorRange(0.62, 0.85)
        : this.behaviorRange(0.05, 0.22);
      this.depthTimer = this.inDeep ? this.behaviorRange(7, 15) : this.behaviorRange(4, 11);
    }
    this.depth = clamp(approach(this.depth, this.depthTarget, called ? 1.6 : 0.9, dt), 0.02, 0.85);

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
        if (Math.random() < CONFIG.bubbles.fishChance) {
          spawnBubbles(this.x, this.y, 2, 9);
        }
        world.onGulp && world.onGulp(this);
      }
      this.gulpTimer = this.behaviorRange(4, 12);
    }

    // a soft wake when swimming fast and near the surface
    if (this.depth < 0.3 && this.speed > this.cruise * 1.2) {      this.wakeClock -= dt;
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
    limitSpineBend(this.spine, 0.42);
    this.buildRenderSpine();
  }

  // the body path plus the travelling wave, as data the shader samples:
  // x, y and the arclength so a pixel knows where it sits on the fish
  buildRenderSpine() {
    const n = SPINE_NODES;
    const data = this.spineData;
    const phase = this.wavePhase || 0;
    const amp = this.length * (0.014 + (this.speed / this.maxSpeed) * 0.042) * this.waveAmpBase;
    let acc = 0;
    let minX = 1e9;
    let minY = 1e9;
    let maxX = -1e9;
    let maxY = -1e9;
    for (let i = 0; i < n; i++) {
      const a = this.spine[Math.max(0, i - 1)];
      const b = this.spine[Math.min(n - 1, i + 1)];
      const tx = b.x - a.x;
      const ty = b.y - a.y;
      const tl = Math.hypot(tx, ty) || 1;
      const nx = -ty / tl;
      const ny = tx / tl;
      const t = i / (n - 1);
      const off = Math.sin(phase - i * 0.9) * amp * Math.pow(t, 1.4);
      if (i > 0) {
        acc += Math.hypot(this.spine[i].x - this.spine[i - 1].x, this.spine[i].y - this.spine[i - 1].y);
      }
      const x = this.spine[i].x + nx * off;
      const y = this.spine[i].y + ny * off;
      data[i * 4] = x;
      data[i * 4 + 1] = y;
      data[i * 4 + 2] = acc;
      data[i * 4 + 3] = 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const total = Math.max(acc, 1e-3);
    for (let i = 0; i < n; i++) data[i * 4 + 2] /= total;
    this.aabb.minX = minX;
    this.aabb.minY = minY;
    this.aabb.maxX = maxX;
    this.aabb.maxY = maxY;
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
    // sinking should read as distance as well as darkness
    return 1 - this.depth * 0.1;
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
    // each school carries its own cruising pace and its own patch of the noise
    // field, otherwise every school in the same water wanders the same way
    this.cruiseSpeed = CONFIG.minnows.cruiseSpeed * rand.range(0.88, 1.14);
    this.dartSpeed = CONFIG.minnows.dartSpeed * rand.range(0.9, 1.1);
    this.noiseSeed = rand.range(0, 400);
    this.speed = this.cruiseSpeed;
    this.state = "cruise";
    this.timer = rand.range(1.4, 4);
    this.targetX = this.x;
    this.targetY = this.y;
    this.dartHeading = this.heading;
    this.waypointX = this.x + Math.cos(this.heading) * 170;
    this.waypointY = this.y + Math.sin(this.heading) * 170;
    this.waypointTimer = rand.range(5, 10);
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
        // one fish is not a copy of its neighbour: its own pace, its own slow
        // yaw, its own slot sway and its own tail beat
        speedMul: rand.range(0.86, 1.15),
        biasAmp: rand.range(0.03, 0.09),
        biasRate: rand.range(0.2, 0.55),
        biasPhase: rand.angle(),
        sway: rand.range(1.1, 2.7),
        tailRate: rand.range(8.4, 11.2),
        spine: [],
        spineData: new Float32Array(MINNOW_NODES * 4),
        aabb: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
        spineTex: null,
      });
    }
    for (const m of this.fish) {
      for (let i = 0; i < MINNOW_NODES; i++) m.spine.push({ x: m.x, y: m.y });
    }
  }

  update(dt, world) {
    const { time, koi, pellets, stones } = world;
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

    // A dart, when it comes, aims well ahead of where the school is pointing:
    // at most 45 degrees off its nose. The old version picked any random point
    // in the pond, so a target behind the school meant a 180 degree turn, and
    // once the school reached the point the bearing flipped and it circled it
    // for a full turn before picking a new one. That was the spin.
    if (this.timer <= 0) {
      if (this.state === "cruise" && (threat > 0.15 || this.rand.chance(0.22))) {
        this.state = "dart";
        this.timer = this.rand.range(0.8, 1.5);
        const bearing = threat > 0.15
          ? Math.atan2(threatY, threatX)
          : this.heading + this.rand.range(-0.8, 0.8);
        const dist = this.rand.range(90, 150);
        this.targetX = clamp(this.x + Math.cos(bearing) * dist, 14, world.res.x - 14);
        this.targetY = clamp(this.y + Math.sin(bearing) * dist, 14, world.res.y - 14);
        // the burst is straight: the bearing is fixed when the dart starts.
        // Steering at the target every frame swung the school in a circle
        // around a point it had already reached.
        this.dartHeading = bearing;
      } else {
        this.state = "cruise";
        this.timer = this.rand.range(2.5, 6);
        // a fresh waypoint, picked ahead of the new heading, so leaving a dart
        // never means turning round to an old target behind the school
        this.waypointTimer = 0;
      }
    }

    // arriving ends the dart; without this the school keeps steering at a point
    // it has already passed and swings round it
    if (this.state === "dart") {
      const far = Math.hypot(this.targetX - this.x, this.targetY - this.y);
      if (far < 30) {
        this.state = "cruise";
        this.timer = this.rand.range(2.5, 6);
        this.waypointTimer = 0;
      }
    }

    let desired;
    if (this.state === "dart") {
      desired = this.dartHeading;
    } else {
      // Cruise to a distant waypoint, re-picked only when it is reached or the
      // timer runs out. Both alternatives end in a circle: steering at a nearby
      // point orbits it, and drifting a relative course turns at the cap for
      // ever. A target far enough ahead can only be reached by swimming to it,
      // and each school picks its own, so they do not all swing the same way.
      this.waypointTimer -= dt;
      const dw = Math.hypot(this.waypointX - this.x, this.waypointY - this.y);
      if (this.waypointTimer <= 0 || dw < 60) {
        const bearing = this.heading + this.rand.range(-0.7, 0.7);
        const dist = this.rand.range(150, 280);
        this.waypointX = clamp(this.x + Math.cos(bearing) * dist, 30, world.res.x - 30);
        this.waypointY = clamp(this.y + Math.sin(bearing) * dist, 30, world.res.y - 30);
        this.waypointTimer = this.rand.range(9, 16);
      }
      desired = Math.atan2(this.waypointY - this.y, this.waypointX - this.x) +
        Math.sin(time * 0.5 + this.noiseSeed) * 0.07;
    }

    // stones standing in the shallows: the school bends round them, and each
    // member that still touches one is pushed out along its edge
    if (stones) {
      let axs = 0;
      let ays = 0;
      for (const st of stones) {
        const a = stoneAvoid(st, this.x, this.y, 20);
        if (!a) continue;
        axs += a.x * a.w;
        ays += a.y * a.w;
      }
      if (axs !== 0 || ays !== 0) {
        const away = Math.atan2(ays, axs);
        // a light bias only: a hard one turned the whole school away and it
        // spent its time avoiding instead of swimming
        const pull = Math.min(0.4, Math.hypot(axs, ays) * 0.35);
        desired = wrapAngle(desired + wrapAngle(away - desired) * pull);
      }
    }

    // The rim is a heading to curve away from, folded into the course, not a
    // second override on top of it. Two overrides near a corner fought each
    // other: one said turn to 0, the other said turn to pi/2, and the school
    // ground round in a small circle instead of leaving.
    const res = world.res;
    const rim = 44;
    let ax = 0;
    let ay = 0;
    if (this.x < rim) ax += (rim - this.x) / rim;
    if (this.x > res.x - rim) ax -= (this.x - (res.x - rim)) / rim;
    if (this.y < rim) ay += (rim - this.y) / rim;
    if (this.y > res.y - rim) ay -= (this.y - (res.y - rim)) / rim;
    if (ax !== 0 || ay !== 0) {
      const away = Math.atan2(ay, ax);
      const pull = Math.min(1, Math.hypot(ax, ay) * 2.2);
      // a transient bias for this frame only: writing it back into the course
      // compounded the bend every frame and turned avoidance into a loop
      desired = wrapAngle(desired + wrapAngle(away - desired) * pull);
    }
    // a school leans into a turn, it does not pivot: 2.4 rad/s covers a right
    // angle in about two thirds of a second, which reads as a wide arc
    this.heading = angleToward(this.heading, desired, (this.state === "dart" ? 2.4 : 1.2) * dt);
    const targetSpeed = this.state === "dart" ? this.dartSpeed : this.cruiseSpeed;
    this.speed = approach(this.speed, targetSpeed, this.state === "dart" ? 6 : 2.2, dt);
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;

    this.x = clamp(this.x, 8, res.x - 8);
    this.y = clamp(this.y, 8, res.y - 8);

    // Slots live in the school's own frame: a little behind the head and off
    // to one side, rotated by the school heading. They used to be world-axis
    // offsets, so with the school swimming in any direction but east, half the
    // school was steering to a point ahead of itself and every fish spent its
    // life turning round to chase its slot. That was the spinning. A member
    // now keeps the school's heading and only leans enough to close a sideways
    // gap; the fore and aft gap is closed with speed, which never asks a fish
    // to turn around.
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    for (const m of this.fish) {
      const wob = Math.sin(time * 0.9 + m.jitter) * m.sway;
      const wob2 = Math.cos(time * 0.8 + m.jitter * 1.3) * m.sway * 0.75;
      const slotX = this.x + (m.ox + wob) * c - (m.oy + wob2) * s;
      const slotY = this.y + (m.ox + wob) * s + (m.oy + wob2) * c;
      const ex = slotX - m.x;
      const ey = slotY - m.y;
      const along = ex * c + ey * s;     // positive: the slot is ahead
      const side = -ex * s + ey * c;     // positive: the slot is to the left
      const lean = clamp(side * 0.05, -0.14, 0.14);
      // a slow yaw of its own on top of the lean, so the school is a crowd and
      // not a rigid body: no two fish hold exactly the same line
      const bias = Math.sin(time * m.biasRate + m.biasPhase) * m.biasAmp +
        Math.sin(time * m.biasRate * 2.3 + m.biasPhase * 1.7) * m.biasAmp * 0.45;
      m.heading = angleToward(m.heading, wrapAngle(this.heading + lean + bias), 3.0 * dt);
      const wanted = clamp(
        this.speed * m.speedMul * (this.state === "dart" ? 1.18 : 1) + along * 1.4,
        3,
        74,
      );
      m.speed = approach(m.speed, wanted, 4.5, dt);
      m.x += Math.cos(m.heading) * m.speed * dt;
      m.y += Math.sin(m.heading) * m.speed * dt;
      if (stones) resolveStones(stones, m, 5);
      m.phase += dt * (m.tailRate + m.speed * 0.12);

      this.buildMemberSpine(m);
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


MinnowSchool.prototype.buildMemberSpine = function (m) {
    const n = MINNOW_NODES;
    const step = CONFIG.minnows.length / (n - 1);
    const dirX = Math.cos(m.heading);
    const dirY = Math.sin(m.heading);
    const perpX = -dirY;
    const perpY = dirX;
    // The swish uses an absolute amplitude. Borrowing the koi's length-relative
    // wave gave a 13 px fish a tail throw of 0.7 px, which is invisible: the
    // tail was effectively frozen and the fish just slid forward.
    const amp = clamp(1.4 + m.speed * 0.045, 1.4, 3.4);
    let minX = 1e9;
    let minY = 1e9;
    let maxX = -1e9;
    let maxY = -1e9;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const lat = Math.sin(m.phase - t * 5.4) * amp * Math.pow(t, 1.6);
      const x = m.x - dirX * step * i + perpX * lat;
      const y = m.y - dirY * step * i + perpY * lat;
      m.spine[i].x = x;
      m.spine[i].y = y;
      m.spineData[i * 4] = x;
      m.spineData[i * 4 + 1] = y;
      m.spineData[i * 4 + 2] = i / (n - 1);
      m.spineData[i * 4 + 3] = 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    // every node bounds the quad, not just the two ends: a swinging tail used
    // to leave the box and get cut off
    m.aabb.minX = minX - 4;
    m.aabb.maxX = maxX + 4;
    m.aabb.minY = minY - 6;
    m.aabb.maxY = maxY + 6;
};

function createSchool(rand, pond, res) {
  const tally = {};
  const koi = [];
  const smallCount = Math.min(CONFIG.koi.smallCount || 0, CONFIG.koi.maxCount);
  // stock by variety so every kind is present in the numbers the panel says
  const stock = [];
  const varieties = CONFIG.koi.varieties || {};
  for (const name of Object.keys(varieties)) {
    for (let k = 0; k < varieties[name]; k++) stock.push(name);
  }
  const bigCount = Math.min(stock.length, CONFIG.koi.maxCount - smallCount);
  for (let i = 0; i < bigCount; i++) {
    koi.push(new Koi(new Rand(CONFIG.seed ^ Math.imul(i + 1, 0x51ed270b)), pond, res, i, tally,
      { variety: stock[i] }));
    tally[stock[i]] = (tally[stock[i]] || 0) + 1;
  }
  for (let i = 0; i < smallCount; i++) {
    // the small orange ones are the last block, so raising or lowering the
    // count trims them before it touches the big koi
    koi.push(new Koi(new Rand(CONFIG.seed ^ Math.imul(bigCount + i + 1, 0x51ed270b)), pond, res,
      bigCount + i, tally, { small: true }));
  }
  const minnows = [];
  for (let i = 0; i < CONFIG.minnows.schools; i++) {
    minnows.push(new MinnowSchool(new Rand(CONFIG.seed ^ Math.imul(i + 3, 0x9e3779b1)), pond, res, i));
  }
  return { koi, minnows, tally };
}
