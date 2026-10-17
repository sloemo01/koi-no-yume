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
      const edge = size * 0.5 + 3;
      const x = clamp(center.x + rand.range(-16, 16), edge, res.x - edge);
      const y = clamp(center.y + rand.range(-13, 13), edge, res.y - edge);
      if (pond.d(x, y) > 0.8) continue;
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
    for (let i = 0; i < count; i++) {
      const x = center.x + rand.range(-26, 26);
      const y = center.y + rand.range(-18, 18);
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

  // ---- clouds (only their shade reaches the pond) ----
  for (let i = 0; i < CONFIG.clouds.count; i++) {
    clouds.push({
      x: rand.range(-0.3, 1.3) * res.x,
      y: rand.range(0.05, 0.9) * res.y,
      r: rand.range(CONFIG.clouds.radius[0], CONFIG.clouds.radius[1]) * (res.x / 480),
      vx: rand.range(CONFIG.clouds.speed[0], CONFIG.clouds.speed[1]) * (res.x / 480),
      shade: CONFIG.clouds.shade[i % CONFIG.clouds.shade.length],
      wobble: rand.angle(),
    });
  }

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
  return { pads, padFlowers, shore, duckweed, weeds, surfaceMoss, clouds };
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

function updateClouds(dt, res, clouds) {
  for (const cloud of clouds) {
    cloud.x += cloud.vx * dt;
    cloud.y += Math.sin(dt * 0.07 + cloud.wobble) * dt * 1.2;
    if (cloud.x > res.x + cloud.r) {
      cloud.x = -cloud.r;
      cloud.y = Math.random() * res.y * 0.9;
    }
  }
}
