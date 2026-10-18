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
      pads.push(pad);
      if (rand.chance(P.flowerChance)) {
        const colorway = rand.pick(["pink", "pink", "white", "red"]);
        padFlowers.push({
          x: x + rand.range(-2.5, 2.5),
          y: y + rand.range(-2.5, 2.5),
          size: rand.int(18, 24),
          rot: rand.range(-0.5, 0.5),
          pad,
          tex: TEXTURES.paintLotusFlower(rand, colorway, 15),
        });
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
      size: rand.range(11, 15),
      rot: rand.angle(),
      vx: 0, vy: 0,
    });
  }

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

  return { pads, padFlowers, shore, duckweed, weeds, surfaceMoss, steppingStones, hyacinths, pot };

}

// pads ride the water: they bob, get pushed by rings, and slowly drift home
function updatePads(dt, time, pads, pond) {
  for (const pad of pads) {
    if (pad.held) continue;
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
    pad.rot += Math.sin(time * 0.4 + pad.bobPhase) * dt * 0.06;
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
      w.vx += f.x * dt * 0.22 * k;
      w.vy += f.y * dt * 0.22 * k;
    }
    w.vx *= Math.exp(-dt * 1.4);
    w.vy *= Math.exp(-dt * 1.4);
    const nx = w.x + w.vx * dt * 10;
    const ny = w.y + w.vy * dt * 10;
    if (pond.d(nx, ny) < 0.9) {
      w.x = nx;
      w.y = ny;
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
