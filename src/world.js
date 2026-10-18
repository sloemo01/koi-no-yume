// Scenery layout: lily pads and their flowers, moss and stones at the
// waterline, reeds, grass tufts and shore flowers on the bank, duckweed
// patches, and the cloud shadows that drift across everything.
// Rebuilding after a resize uses the same seed, so the pond keeps its layout.
"use strict";

function buildScenery(rand, res, pond) {
  const pads = [];
  const padFlowers = [];
  const shore = [];
  const duckweed = [];
  const clouds = [];

  const P = CONFIG.pads;
  const placed = [];
  // Every pad placed so far, across every cluster. The separation has to be
  // checked against all of them: a per-cluster list let a pad from one cluster
  // grow into a pad from the next, and then the pad you pressed was whichever
  // one happened to be painted later.
  const padSpots = [];
  const clusters = rand.int(P.clusters[0], P.clusters[1]);
  for (let c = 0; c < clusters; c++) {
    let center = null;
    for (let tries = 0; tries < 30 && !center; tries++) {
      const p = pond.randomPoint(rand, 0.7, 0.18);
      if (placed.every((q) => Math.hypot(p.x - q.x, p.y - q.y) > 62)) center = p;
    }
    if (!center) continue;
    placed.push(center);
    const count = rand.int(P.perCluster[0], P.perCluster[1]);
    for (let i = 0; i < count; i++) {
      const size = Math.round(rand.range(P.size[0], P.size[1]));
      // keep the whole pad inside the frame, not half off the bottom edge
      const r = size * 0.5;
      const edge = r + 3;
      let x = center.x;
      let y = center.y;
      let clear = false;
      // Walk the pads out from the cluster centre until each one has a spot of
      // its own. The old jitter put pads within a couple of pixels of each
      // other, so a later pad covered an earlier one completely: you would
      // press the pad you could see and grab one hidden underneath it.
      for (let tries = 0; tries < 60 && !clear; tries++) {
        const a = rand.angle();
        const d = rand.range(r * 1.2, r * 2.8);
        x = clamp(center.x + Math.cos(a) * d * 1.12, edge, res.x - edge);
        y = clamp(center.y + Math.sin(a) * d * 0.84, edge, res.y - edge);
        // no overlap at all: two discs that intersect would make the pad you
        // press depend on which one is painted on top
        clear = padSpots.every((q) => Math.hypot(x - q.x, y - q.y) > r + q.r + 3);
      }
      // clusters still read as clusters: they sit close enough to touch, with
      // water showing between them
      if (!clear) continue;
      if (pond.d(x, y) > 0.8) continue;
      padSpots.push({ x, y, r });
      const pad = {
        x, y, size,
        r: size * 0.5,
        rot: rand.angle(),
      // idle: each pad creeps a couple of pixels around its home on its own
      // slow cycle, so the surface is never dead still but nothing drifts away
      waterBias: rand.range(0.65, 1.45),
        homeX: x,
        homeY: y,
        driftX: 0,
        driftY: 0,
        shade: rand.range(0.88, 1.1),
        tex: TEXTURES.paintLilyPad(rand, size),
        bobPhase: rand.angle(),
        held: false,
        pressedAt: 0,
      };
      pad.baseRot = pad.rot;
      pads.push(pad);
      if (rand.chance(P.flowerChance)) {
        const colorway = rand.pick(["pink", "pink", "white", "red"]);
        const fx = x + rand.range(-2.5, 2.5);
        const fy = y + rand.range(-2.5, 2.5);
        padFlowers.push({
          x: fx,
          y: fy,
          // where it sits on its own pad, so it can ride the leaf when the leaf
          // drifts instead of staying pinned to where the pad used to be
          ox: fx - pad.x,
          oy: fy - pad.y,
          size: rand.int(18, 24),
          rot: rand.range(-0.5, 0.5),
          baseRot: 0,
          seed: rand.angle(),
          pad,
          tex: TEXTURES.paintLotusFlower(rand, colorway, 15),
        });
        padFlowers[padFlowers.length - 1].baseRot = padFlowers[padFlowers.length - 1].rot;
      }
    }
  }

  // ---- plants and stones around the frame ----
  // the bank sits just outside the view, so reeds and grass lean in over the
  // edge and mossy stones stand in the shallows
  const mossTexs = [];
  for (let i = 0; i < 5; i++) mossTexs.push(TEXTURES.paintMossClump(rand, ["#4e7a34", "#3c6128"]));
  const stoneTexs = [];
  for (let i = 0; i < 3; i++) stoneTexs.push(TEXTURES.paintStone(rand));
  const tuftTexs = [];
  for (let i = 0; i < 4; i++) tuftTexs.push(TEXTURES.paintGrassTuft(rand, [["#5d8f3a", "#4a7a2e"], ["#548438", "#42692a"], ["#6b9b42", "#527d31"]][i % 3]));
  const reedTexs = [];
  for (let i = 0; i < 2; i++) reedTexs.push(TEXTURES.paintReedClump(rand));
  const flowerTexs = [];
  for (const colorway of ["white", "yellow", "blue", "pink"]) {
    flowerTexs.push(TEXTURES.paintShoreFlower(rand, colorway));
    flowerTexs.push(TEXTURES.paintShoreFlower(rand, colorway));
  }

  for (let i = 0; i < CONFIG.moss.clumps; i++) {
    const p = pond.edgePoint(rand, rand.range(-2, 16));
    const scale = rand.range(0.8, 1.5);
    shore.push({
      tex: rand.pick(mossTexs),
      x: p.x, y: p.y, w: 13 * scale, h: 9 * scale,
      rot: rand.range(-0.25, 0.25), anchor: "center", submerged: true,
    });
  }
  for (let i = 0; i < CONFIG.stones.count; i++) {
    // a few rocks sit out in the open water, the rest line the shallows
    const p = i < 4 ? pond.randomPoint(rand, 0.62, 0.3) : pond.edgePoint(rand, rand.range(-8, 12));
    const scale = rand.range(0.75, 1.4);
    shore.push({
      tex: rand.pick(stoneTexs),
      x: p.x, y: p.y, w: 16 * scale, h: 11 * scale,
      rot: rand.range(-0.3, 0.3), anchor: "center", submerged: true,
    });
    // moss grows on stones
    if (rand.chance(0.55)) {
      const m = rand.range(0.7, 1.15);
      shore.push({
        tex: rand.pick(mossTexs),
        x: p.x + rand.range(-4, 4), y: p.y + rand.range(-3, 2), w: 13 * m, h: 9 * m,
        rot: rand.range(-0.3, 0.3), anchor: "center", submerged: true,
      });
    }
  }
  // weed beds on the floor of the shallows
  const pondWeedTexs = [];
  for (let i = 0; i < 3; i++) pondWeedTexs.push(TEXTURES.paintPondWeed(rand));
  const weeds = [];
  for (let i = 0; i < CONFIG.weeds.clumps; i++) {
    const p = pond.randomPoint(rand, 0.68, 0.26);
    const scale = rand.range(0.85, 1.5);
    weeds.push({
      tex: rand.pick(pondWeedTexs),
      x: p.x, y: p.y, w: 14 * scale, h: 26 * scale,
      rot: rand.range(-0.4, 0.4),
    });
  }
  for (let i = 0; i < CONFIG.reeds.clusters; i++) {
    const p = pond.edgePoint(rand, rand.range(-1, 5));
    const scale = rand.range(0.85, 1.35);
    shore.push({
      tex: rand.pick(reedTexs),
      x: p.x, y: p.y, w: 13 * scale, h: 16 * scale,
      rot: rand.range(-0.1, 0.1), anchor: "bottom", submerged: false,
    });
  }
  for (let i = 0; i < CONFIG.tufts.count; i++) {
    const p = pond.edgePoint(rand, rand.range(-3, 4));
    const scale = rand.range(0.65, 1.3);
    shore.push({
      tex: rand.pick(tuftTexs),
      x: p.x, y: p.y, w: 11 * scale, h: 9 * scale,
      rot: rand.range(-0.12, 0.12), anchor: "bottom", submerged: false,
    });
  }
  for (let i = 0; i < CONFIG.shoreFlowers.clusters; i++) {
    const p = pond.edgePoint(rand, rand.range(-2, 4));
    const scale = rand.range(0.8, 1.25);
    shore.push({
      tex: rand.pick(flowerTexs),
      x: p.x, y: p.y, w: 7 * scale, h: 10 * scale,
      rot: rand.range(-0.08, 0.08), anchor: "bottom", submerged: false,
    });
  }
  shore.sort((a, b) => (a.submerged === b.submerged ? 0 : a.submerged ? -1 : 1));

  // ---- duckweed ----
  const weedTexs = [];
  for (let i = 0; i < 3; i++) weedTexs.push(TEXTURES.paintDuckweed(rand));
  for (let p = 0; p < CONFIG.duckweed.patches; p++) {
    const center = pond.randomPoint(rand, 0.78, 0.1);
    const count = rand.int(CONFIG.duckweed.perPatch[0], CONFIG.duckweed.perPatch[1]);
    const sx = (CONFIG.duckweed.spread && CONFIG.duckweed.spread[0]) || 34;
    const sy = (CONFIG.duckweed.spread && CONFIG.duckweed.spread[1]) || 24;
    for (let i = 0; i < count; i++) {
      // a raft, not a cloud: most motes hug the middle, a few straggle out
      const r = Math.pow(rand.unit(), 1.8);
      const a = rand.angle();
      const x = center.x + Math.cos(a) * r * sx;
      const y = center.y + Math.sin(a) * r * sy;
      if (pond.d(x, y) > 0.86) continue;
      duckweed.push({
        tex: rand.pick(weedTexs),
        x, y,
        // where this mote grew: a raft drifts with the water but stays in its
        // own stretch of the pond instead of migrating to a wall
        homeX: x,
        homeY: y,
        rot: rand.angle(),
        size: rand.range(1, 1.5),
        phase: rand.angle(),
        vx: rand.range(-0.3, 0.3),
        vy: rand.range(-0.3, 0.3),
      });
    }
  }

  // Clouds are not objects any more: their shade is one drifting noise field
  // in the composite pass, so there is nothing to lay out here.

  // ---- moss mats floating on the surface ----
  const surfaceMossTexs = [];
  for (let i = 0; i < 4; i++) surfaceMossTexs.push(TEXTURES.paintFloatingMoss(rand));
  const surfaceMoss = [];
  for (let c = 0; c < CONFIG.surfaceMoss.clumps; c++) {
    const p = pond.randomPoint(rand, 0.72, 0.16);
    const mats = rand.int(1, 3);
    for (let i = 0; i < mats; i++) {
      const size = rand.range(CONFIG.surfaceMoss.size[0], CONFIG.surfaceMoss.size[1]);
      const mx = clamp(p.x + rand.range(-9, 9), size * 0.6 + 3, res.x - size * 0.6 - 3);
      const my = clamp(p.y + rand.range(-7, 7), size * 0.5 + 3, res.y - size * 0.5 - 3);
      surfaceMoss.push({
        tex: rand.pick(surfaceMossTexs),
        x: mx, y: my, size,
        rot: rand.range(0, Math.PI * 2),
        homeX: mx,
        homeY: my,
        held: false,
        vx: 0,
        vy: 0,
      });
    }
  }
  // ---- tobi-ishi: stepping stones scattered around the pond ----------------
  // Loose chains with wide random turns, plus a handful of loners: enough
  // structure to read as stones someone set down, not so much that the pond
  // looks like it has three tidy paths in it. Every stone gets its own size,
  // squash and rotation, so no two are the same object twice.
  const steppingStones = [];
  {
    const S = CONFIG.stepping;
    const tryPlace = (x, y) => {
      if (x < 12 || y < 12 || x > res.x - 12 || y > res.y - 12) return false;
      if (pond.d(x, y) > 0.97) return false;
      const sc = rand.range(S.size[0], S.size[1]);
      const w = 22 * sc;
      const h = 15 * sc * rand.range(0.85, 1.15);
      for (const other of steppingStones) {
        // Keep a real channel between stones, not just enough to stop the
        // sprites touching. A koi is about 14 px wide, so a 16 px corridor is
        // water it can actually swim through; any tighter and the gap is a
        // gap on paper only.
        if (Math.hypot(x - other.x, y - other.y) < (w + other.w) * 0.5 + 16) return false;
      }
      steppingStones.push({
        tex: TEXTURES.paintSteppingStone(rand),
        x, y, w, h,
        rot: rand.angle(),
      });
      return true;
    };
    // chains: a walk that keeps turning, so a run bends instead of ruling a line
    for (let g = 0; g < S.runs; g++) {
      const start = pond.randomPoint(rand, 0.95, 0.35);
      let h = rand.angle();
      let x = start.x;
      let y = start.y;
      const count = rand.int(S.runLength[0], S.runLength[1]);
      for (let i = 0; i < count; i++) {
        if (!tryPlace(x, y) && i === 0) break;
        h += rand.range(-1.0, 1.0);
        const step = rand.range(S.spread[0], S.spread[1]);
        x += Math.cos(h) * step;
        y += Math.sin(h) * step;
        if (x < 12 || y < 12 || x > res.x - 12 || y > res.y - 12) break;
        if (pond.d(x, y) > 0.97) break;
      }
    }
    // loners, anywhere in the shallows or the middle
    for (let i = 0; i < S.loners; i++) {
      const p = pond.randomPoint(rand, 0.97, 0.3);
      tryPlace(p.x, p.y);
    }
  }


  // ---- water hyacinth: rosettes with roots hanging into the water ----------
  const hyacinths = [];
  for (let i = 0; i < CONFIG.hyacinths.count; i++) {
    const p = pond.randomPoint(rand, 0.88, 0.15);
    hyacinths.push({
      tex: TEXTURES.paintWaterHyacinth(rand),
      x: p.x, y: p.y,
      homeX: p.x, homeY: p.y,
      size: rand.range(11, 15),
      rot: rand.angle(),
      vx: 0, vy: 0,
    });
  }

  // ---- a rowboat, moored offshore and drifting ----------------------------
  const boat = (() => {
    const tex = TEXTURES.paintBoat(rand);
    // The hull is sized against the frame, not fixed. On a phone the whole world
    // is about 130 px wide, and a 120 px boat was almost the full width of the
    // pond and had nowhere legal to sit. It keeps its desktop length and shrinks
    // with the frame on small screens.
    const size = Math.round(clamp(res.x * 0.58, 76, 120));
    const halfW = size * 0.62;
    const halfH = size * 0.40;
    // a clear stretch of open water, away from the pads and stones
    let spot = null;
    for (let tries = 0; tries < 40 && !spot; tries++) {
      const p = pond.randomPoint(rand, 0.55, 0.1);
      // on a phone the top bar covers about a quarter of the frame, so a hull
      // that spawns up there is hidden behind the controls until you hide them
      const topInset = Pond.state && Pond.state.touch ? res.y * 0.30 : halfH;
      if (p.x < halfW || p.x > res.x - halfW || p.y < topInset || p.y > res.y - halfH) continue;
      // Clearance has to shrink with the pond. On a phone the world is about 130
      // px wide and the pads sit everywhere, so a desktop sized gap rejected
      // every candidate and the hull fell back to an unchecked point, half of it
      // outside the frame.
      const padGap = Math.min(size * 0.7, size * 0.45 + 6);
      let clear = true;
      for (const pad of pads) {
        if (Math.hypot(pad.x - p.x, pad.y - p.y) < padGap) { clear = false; break; }
      }
      if (clear) {
        for (const st of steppingStones) {
          if (Math.hypot(st.x - p.x, st.y - p.y) < size * 0.5) { clear = false; break; }
        }
      }
      if (clear) spot = p;
    }
    if (!spot) {
      const p = pond.randomPoint(rand, 0.6, 0.1);
      const topInset = Pond.state && Pond.state.touch ? res.y * 0.30 : halfH;
      spot = {
        x: clamp(p.x, halfW, res.x - halfW),
        y: clamp(p.y, topInset, res.y - halfH),
      };
    }
    return {
      tex: tex.canvas,
      x: spot.x, y: spot.y,
      homeX: spot.x, homeY: spot.y,
      size,
      margin: Math.round(size * 0.57),
      rot: rand.angle(),
      baseRot: 0,
      vx: 0, vy: 0,
    };
  })();

  // ---- a clay pot on its side in the shallows ------------------------------
  const pot = (() => {
    // The frame crops the middle of a larger pond, so depth never gets past
    // about 0.6 inside the view. Asking for the shallow rim put this at the
    // fallback point, which is the exact middle of the water.
    const p = pond.randomPoint(rand, 0.6, 0.42);
    return {
      tex: TEXTURES.paintClayPot(rand),
      x: p.x, y: p.y,
      w: 24, h: 16,
      rot: rand.range(-0.6, 0.6) + Math.atan2(p.y - pond.cy, p.x - pond.cx),
      mouth: { x: 0, y: 0 },
    };
  })();
  // where the mouth ends up in world space, so fish can nose at it
  {
    const c = Math.cos(pot.rot);
    const s2 = Math.sin(pot.rot);
    pot.mouth.x = pot.x + (-0.4 * c - 0 * s2) * 0 + 8 * c;
    pot.mouth.y = pot.y + 8 * s2;
  }

  return { pads, padFlowers, shore, duckweed, weeds, surfaceMoss, steppingStones, hyacinths, pot, boat };

}

// pads ride the water: they bob, get pushed by rings, and slowly drift home
function updatePads(dt, time, pads, pond) {
  for (const pad of pads) {
    if (pad.held) continue;

    // ---- a thrown pad skids ------------------------------------------------
    if (pad.thrown) {
      const speed = Math.hypot(pad.vx || 0, pad.vy || 0);
      // a thrown leaf stays in the frame you can see: the pond is much larger
      // than the view, so the bank check alone let it sail off screen
      const margin = pad.size * 0.5 + 2;
      const frame = (typeof Pond !== "undefined" && Pond.world && Pond.world.res)
        ? Pond.world.res : { x: 450, y: 227 };
      const wantX = pad.x + (pad.vx || 0) * dt;
      const wantY = pad.y + (pad.vy || 0) * dt;
      const nx = Math.min(frame.x - margin, Math.max(margin, wantX));
      const ny = Math.min(frame.y - margin, Math.max(margin, wantY));
      // hit the edge: give the velocity back, damped, so it slides along the rim
      // instead of grinding into it
      if (nx !== wantX) pad.vx *= -0.3;
      if (ny !== wantY) pad.vy *= -0.3;
      if (pond.d(nx, ny) >= 0.88) {
        // the bank stops it: kill the outward part and splash once
        pad.vx *= -0.28;
        pad.vy *= -0.28;
        spawnRipple("splash", pad.x, pad.y, { scale: 0.5 });
      } else {
        pad.x = nx;
        pad.y = ny;
      }
      // a thrown leaf spins, and water slows it quickly
      pad.rot += (pad.spin || 0) * dt;
      pad.spin = (pad.spin || 0) + (Math.hypot(pad.vx || 0, pad.vy || 0) > 30 ? dt * 0.9 * Math.sign(pad.spin || 1) : 0);
      pad.vx *= Math.exp(-dt * 1.7);
      pad.vy *= Math.exp(-dt * 1.7);
      // a wake behind it while it is still moving
      pad.wakeClock = (pad.wakeClock || 0) + dt;
      if (speed > 45 && pad.wakeClock > 0.07) {
        pad.wakeClock = 0;
        spawnRipple("wake", pad.x, pad.y, { scale: 1.2 });
      }
      if (speed < 14) {
        // stopped: this is home now, so it does not slide back to where it began
        pad.thrown = false;
        pad.vx = 0;
        pad.vy = 0;
        pad.spin = 0;
        pad.homeX = pad.x;
        pad.homeY = pad.y;
        spawnRipple("mouth", pad.x, pad.y, { scale: 0.5 });
      }
      continue;
    }
    // Pads only sip the push. At full strength a drag through open water
    // shoved every pad near the cursor away from it, which reads as a pad
    // moving opposite to your hand.
    const push = waterPushAt(pad.x, pad.y, dt);
    pad.driftX += push.x * 0.3;
    pad.driftY += push.y * 0.3;
    // pull back toward home so the pond keeps its composition
    pad.driftX += (pad.homeX - pad.x - pad.driftX) * dt * 0.35;
    pad.driftY += (pad.homeY - pad.y - pad.driftY) * dt * 0.35;
    pad.driftX *= Math.exp(-dt * 0.8);
    pad.driftY *= Math.exp(-dt * 0.8);
    const drift = Math.hypot(pad.driftX, pad.driftY);
    if (drift > 4) {
      pad.driftX *= 4 / drift;
      pad.driftY *= 4 / drift;
    }
    const nx = pad.x + pad.driftX * dt * 6;
    const ny = pad.y + pad.driftY * dt * 6;
    if (pond.d(nx, ny) < 0.86) {
      pad.x = nx;
      pad.y = ny;
    }

    // ---- motion that comes from the water --------------------------------
    // No idle animation: a pad moves because the surface under it is moving. The
    // swell gives a height field, so its local slope pushes the pad off the crest
    // the way a leaf slides off a wave, and the flow field carries it slowly.
    // Scaled by each pad's own sensitivity so they do not move in lockstep.
    const bias = pad.waterBias || 1;
    // Sample the slope over a wide baseline. At four pixels the swell's short
    // wavelengths flipped the sign every few frames, and a pad sitting on one of
    // those ripples shivered against the surface instead of riding it.
    const eps = 11;
    const h0 = waterBobAt(pad.x, pad.y, time);
    const hx = waterBobAt(pad.x + eps, pad.y, time);
    const hy = waterBobAt(pad.x, pad.y + eps, time);
    const slopeX = (hx - h0) / eps;
    const slopeY = (hy - h0) / eps;
    pad.driftX -= slopeX * 20 * bias * dt;
    pad.driftY -= slopeY * 20 * bias * dt;
    if (typeof Pond !== "undefined" && Pond.flow) {
      const f = Pond.flow.sample(pad.x, pad.y);
      pad.driftX += f.x * dt * 0.05 * bias;
      pad.driftY += f.y * dt * 0.05 * bias;
    }
    // Damp the drift, or the home spring rings: a pad would shoot toward home,
    // overshoot, and bounce back, which is that one leaf twitching on the surface.
    const damp = Math.exp(-dt * 2.4);
    pad.driftX *= damp;
    pad.driftY *= damp;
    const sp = Math.hypot(pad.driftX, pad.driftY);
    const maxSp = 4.5;
    if (sp > maxSp) {
      pad.driftX *= maxSp / sp;
      pad.driftY *= maxSp / sp;
    }
    // rock about its rest angle instead of accumulating, so it cannot spin away
    pad.rot = (pad.baseRot === undefined ? pad.rot : pad.baseRot) + slopeY * 0.09 * bias;
  }
}

// floaters just drift and bob; rate lets the heavy moss mats move slower
function updateDuckweed(dt, time, weed, pond, rate) {
  for (const w of weed) {
    if (w.held) continue;
    const k = rate === undefined ? 1 : rate;
    const push = waterPushAt(w.x, w.y, dt);
    w.vx += push.x * 1.6 * k;
    w.vy += push.y * 1.6 * k;
    // the flow field carries it, so duckweed piles up in the lee of a stone and
    // rides the eddy behind it instead of drifting on a sine wave
    if (typeof Pond !== "undefined" && Pond.flow) {
      const f = Pond.flow.sample(w.x, w.y);
      w.vx += f.x * dt * 0.16 * k;
      w.vy += f.y * dt * 0.16 * k;
    }
    // A weak tether to where the mote grew. Without it the whole population is
    // a single tracer for the current and ends up piled in whichever corner the
    // gyre favours; with it each raft wanders ten or twenty pixels and the pond
    // keeps its cover where it was planted.
    if (w.homeX !== undefined) {
      w.vx += (w.homeX - w.x) * 0.045 * dt * k;
      w.vy += (w.homeY - w.y) * 0.045 * dt * k;
    }
    // ---- the frame edge ---------------------------------------------------
    // The flow grid is zero in its outer cells, so anything the current carried
    // to the right or bottom edge arrived at still water and stayed there. The
    // pond's own rim sits outside the frame, so the old "is this still water?"
    // test never triggered and duckweed stacked along the edges of the view.
    // Steer floaters back off the frame and clamp them inside it.
    const res = (typeof Pond !== "undefined" && Pond.world) ? Pond.world.res : null;
    if (res) {
      const m = w.margin || 16;
      let ax = 0;
      let ay = 0;
      if (w.x < m) ax += (m - w.x) / m;
      if (w.x > res.x - m) ax -= (w.x - (res.x - m)) / m;
      if (w.y < m) ay += (m - w.y) / m;
      if (w.y > res.y - m) ay -= (w.y - (res.y - m)) / m;
      if (ax !== 0 || ay !== 0) {
        w.vx += ax * 11 * dt * k;
        w.vy += ay * 11 * dt * k;
      }
    }
    w.vx *= Math.exp(-dt * 1.4);
    w.vy *= Math.exp(-dt * 1.4);
    const nx = w.x + w.vx * dt * 10;
    const ny = w.y + w.vy * dt * 10;
    if (pond.d(nx, ny) < 0.9) {
      w.x = nx;
      w.y = ny;
    }
    if (res) {
      // a hard stop at the very edge, so nothing can drift out of view
      if (w.x < 2) { w.x = 2; w.vx = Math.abs(w.vx) * 0.4; }
      if (w.x > res.x - 2) { w.x = res.x - 2; w.vx = -Math.abs(w.vx) * 0.4; }
      if (w.y < 2) { w.y = 2; w.vy = Math.abs(w.vy) * 0.4; }
      if (w.y > res.y - 2) { w.y = res.y - 2; w.vy = -Math.abs(w.vy) * 0.4; }
    }
    w.rot += dt * 0.1 * (rate === undefined ? 1 : rate);
  }
}


// ---- stepping stones are solid, so fish have to go round them --------------
// A stone is an ellipse in its own rotated frame. Both helpers work in that
// frame: the sprite is drawn at w by h, so the footprint is a little inside it.
function stoneLocal(stone, x, y) {
  const c = Math.cos(-stone.rot);
  const s = Math.sin(-stone.rot);
  const dx = x - stone.x;
  const dy = y - stone.y;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

// a steering push away from one stone, or null when the fish is clear of it
function stoneAvoid(stone, x, y, pad) {
  const l = stoneLocal(stone, x, y);
  const rx = stone.w * 0.42 + pad;
  const ry = stone.h * 0.42 + pad;
  const q = Math.hypot(l.x / rx, l.y / ry);
  if (q > 1.4 || q < 1e-3) return null;
  // outward normal of the ellipse, rotated back into the world
  const nx = l.x / (rx * rx);
  const ny = l.y / (ry * ry);
  const len = Math.hypot(nx, ny) || 1;
  const c = Math.cos(stone.rot);
  const s = Math.sin(stone.rot);
  return {
    x: (nx / len) * c - (ny / len) * s,
    y: (nx / len) * s + (ny / len) * c,
    w: Math.min(1.5, (1.4 - q) * 2.0),
  };
}

// last resort: if a fish still ends up inside a stone, put it on the rim along
// the direction it came from, so it slides out instead of popping across
function resolveStones(stones, obj, pad) {
  if (!stones) return null;
  let touched = null;
  for (const stone of stones) {
    const l = stoneLocal(stone, obj.x, obj.y);
    const rx = stone.w * 0.42 + pad;
    const ry = stone.h * 0.42 + pad;
    const q = Math.hypot(l.x / rx, l.y / ry);
    if (q >= 1) continue;
    if (!touched) touched = stone;
    const c = Math.cos(stone.rot);
    const s = Math.sin(stone.rot);
    let lx;
    let ly;
    if (q < 0.05) {
      // dead centre: leave along the fish's own heading
      const h = obj.heading || 0;
      lx = Math.cos(h) * rx * 1.04;
      ly = Math.sin(h) * ry * 1.04;
    } else {
      // a hair past the rim, so the fish is clearly outside and not sitting on
      // the edge where the stone still covers half of it
      lx = (l.x / q) * 1.04;
      ly = (l.y / q) * 1.04;
    }
    obj.x = stone.x + lx * c - ly * s;
    obj.y = stone.y + lx * s + ly * c;
  }
  return touched;
}

// The most open way out of wherever a fish has ended up. Sixteen rays, each
// scored by how far it runs before the frame edge or a stone, and the best one
// wins. Steering toward the middle of the pond is not enough: from the
// lower-left corner the straight line to the middle goes through the stones.
function openDirection(obj, stones, res, reach) {
  const radius = reach || 40;
  let bestAngle = 0;
  let bestScore = -1e9;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let score = 1e9;
    // Sample along the ray, not just at its end: a direction can look open at
    // 48 px and still run through a stone at 20, which is how a fish picks an
    // escape route that leads it straight back into the pocket.
    for (let step = 1; step <= 4; step++) {
      const px = obj.x + ca * radius * (step / 4);
      const py = obj.y + sa * radius * (step / 4);
      let s = Math.min(px, res.x - px, py, res.y - py);
      if (stones) {
        for (const st of stones) {
          const d = Math.hypot(px - st.x, py - st.y) - st.w * 0.5;
          if (d < s) s = d;
        }
      }
      if (s < score) score = s;
      if (score < -20) break;
    }
    if (score > bestScore) { bestScore = score; bestAngle = a; }
  }
  return bestAngle;
}
