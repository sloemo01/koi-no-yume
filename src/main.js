// Boot, input, and the frame loop. jQuery handles the input plumbing and
// drives every ripple job (see water.js); the rest is fixed-step simulation.
"use strict";

const Pond = {
  world: null,
  gfx: null,
  school: null,
  butterflies: [],
  scenery: null,
  state: {
    pixelSize: 4,
    koiCount: 12,
    showSpines: false,
    hidden: false,
    sound: false,
    seed: 20261017,
    fps: 0,
    frames: 0,
    fpsClock: 0,
    pointer: { x: 0, y: 0, down: false },
    dragPad: null,
    lastWake: 0,
    lastDragSpawn: { x: -999, y: -999 },
    demo: false,
    demoTimer: 0,
    demoStage: 0,
    freeze: false,
  },
};

// ------------------------------------------------------------------ sound

const Sound = {
  ctx: null,
  master: null,
  enabled: false,
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = CONFIG.sound.volume;
    this.master.connect(this.ctx.destination);
  },
  setEnabled(on) {
    this.enabled = on;
    if (on) {
      this.init();
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    }
  },
  plop(strength) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(520 + Math.random() * 120, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.16);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16 * (strength || 1), t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.3);
    // a breath of filtered noise on top
    const buf = this.ctx.createBuffer(1, 2205, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    const ng = this.ctx.createGain();
    ng.gain.value = 0.06 * (strength || 1);
    src.connect(lp);
    lp.connect(ng);
    ng.connect(this.master);
    src.start(t);
  },
  gulp() {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.1);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.09, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.18);
  },
};

// ------------------------------------------------------------------ setup

function params() {
  const q = new URLSearchParams(window.location.search);
  const out = {};
  if (q.has("seed")) out.seed = parseInt(q.get("seed"), 10) || 1;
  if (q.has("px")) out.pixelSize = clamp(parseInt(q.get("px"), 10) || 4, 2, 8);
  if (q.has("koi")) out.koiCount = clamp(parseInt(q.get("koi"), 10) || 12, 1, CONFIG.koi.maxCount);
  if (q.has("t")) out.fastForward = Math.max(0, parseFloat(q.get("t")) || 0);
  if (q.has("demo")) out.demo = q.get("demo") === "1";
  if (q.has("freeze")) out.freeze = q.get("freeze") === "1";
  return out;
}

function boot() {
  const canvas = document.getElementById("pond");
  const options = params();
  const st = Pond.state;
  st.seed = options.seed || CONFIG.seed;
  if (options.pixelSize) st.pixelSize = options.pixelSize;
  if (options.koiCount) CONFIG.koi.count = options.koiCount;
  st.koiCount = CONFIG.koi.count;
  st.demo = !!options.demo;
  st.freeze = !!options.freeze;

  const gfx = new Gfx(canvas);
  Pond.gfx = gfx;

  const rand = new Rand(st.seed);
  const rimTable = makeRimTable();

  const world = {
    res: { x: 2, y: 2 },
    time: 0,
    pond: null,
    rimTable,
    koi: [],
    count: 0,
    minnows: [],
    pellets: [],
    call: { x: 0, y: 0, age: 999, duration: 2.6, radius: 150, active: false },
    clouds: [],
    ringUniformCount: 0,
    onGulp: () => Sound.gulp(),
  };
  Pond.world = world;

  fit(true);

  Pond.school = createSchool(rand, world.pond, world.res);
  world.koi = Pond.school.koi;
  world.minnows = Pond.school.minnows;
  world.count = st.koiCount;
  for (const k of world.koi) {
    k.mesh = gfx.createFishMesh(k.extents, SPINE_NODES, k.spineRow, k.height, k.length);
  }
  Pond.butterflies = createButterflies(new Rand(st.seed ^ 0x5bf03635), world.res);

  buildSceneryFor(world);

  // fast-forward the simulation so screenshots and links can start in a
  // settled pond
  if (options.fastForward) {
    WATER_FIELD.suppress = true;
    const steps = Math.min(60 * 120, Math.round(options.fastForward * 60));
    for (let i = 0; i < steps; i++) {
      world.time += 1 / 60;
      simulate(1 / 60);
    }
    WATER_FIELD.suppress = false;
    st.demoTimer = 0;
  }

  installInput(canvas);

  // paint one frame synchronously: a tab that is not visible yet gets no
  // animation frames, and the pond must not be blank when it is looked at
  drawFrame();
  $(document).on("visibilitychange", () => {
    if (!document.hidden) {
      lastFrame = 0;
      drawFrame();
    }
  });
  $(window).on("focus", () => {
    lastFrame = 0;
    drawFrame();
  });
  requestAnimationFrame(frame);

  window.__pond = {
    world,
    gfx,
    state: st,
    stats: () => ({
      time: +world.time.toFixed(2),
      fps: st.fps,
      koi: world.count,
      koiAlive: world.koi.filter((k) => world.koi.indexOf(k) < world.count).length,
      rings: WATER_FIELD.rings.length,
      jobs: WATER_FIELD.jobs,
      spawned: WATER_FIELD.spawned,
      ringUniforms: world.ringUniformCount,
      pellets: world.pellets.length,
      butterflies: Pond.butterflies.length,
      pads: Pond.scenery.pads.length,
      pixelSize: st.pixelSize,
      res: { x: world.res.x, y: world.res.y },
      errs: (window.__errs || []).slice(0, 5),
    }),
    koi: () =>
      world.koi.slice(0, world.count).map((k) => ({
        x: +k.x.toFixed(1), y: +k.y.toFixed(1), d: +k.depth.toFixed(2),
        v: +k.speed.toFixed(2), state: k.state, variety: k.variety,
      })),
    pads: () =>
      Pond.scenery.pads.map((p) => ({
        x: +p.x.toFixed(1), y: +p.y.toFixed(1), r: p.r, held: p.held,
      })),
    rings: () =>
      WATER_FIELD.rings.map((r) => ({
        kind: r.kind, x: +r.x.toFixed(1), y: +r.y.toFixed(1),
        radius: +r.radius.toFixed(1), amp: +r.amp.toFixed(3),
      })),
    spawnAt: (x, y, kind) => {
      spawnRipple(kind || "touch", x, y, {});
      return WATER_FIELD.rings.length;
    },
    feedAt: (x, y) => feed(x, y),
    click: (x, y) => handleWaterClick(x, y),
    dragStart: (x, y) => handlePointerDown(x, y),
    dragTo: (x, y) => handlePointerMove(x, y),
    dragEnd: () => handlePointerUp(),
    resize: () => fit(false),
    setPixelSize: (p) => setPixelSize(p),
    freeze: (v) => {
      Pond.state.freeze = !!v;
      return Pond.state.freeze;
    },
    clearRings: () => {
      resetWaterField();
      return WATER_FIELD.rings.length;
    },
    scatter: () => {
      scatter();
      return true;
    },
    key: (k) => handleKey(k),
    padAt: (x, y) => {
      const pad = findPadAt(x, y);
      return pad ? { x: +pad.x.toFixed(1), y: +pad.y.toFixed(1), r: pad.r } : null;
    },
    koiDistTo: (x, y) => {
      const list = Pond.world.koi.slice(0, Pond.world.count);
      const dists = list.map((k) => Math.hypot(k.x - x, k.y - y));
      const mean = dists.reduce((a, b) => a + b, 0) / Math.max(1, dists.length);
      return {
        mean: +mean.toFixed(1),
        min: +Math.min(...dists).toFixed(1),
        near: dists.filter((d) => d < 40).length,
        meanDepth: +(list.reduce((a, k) => a + k.depth, 0) / Math.max(1, list.length)).toFixed(2),
      };
    },
  };
}

function buildSceneryFor(world) {
  const rand = new Rand(Pond.state.seed ^ 0x9e3779b9);
  Pond.scenery = buildScenery(rand, world.res, world.pond);
  world.clouds = Pond.scenery.clouds;
}

// keep every backing buffer in step with the window
function fit(initial) {
  const canvas = Pond.gfx.canvas;
  const st = Pond.state;
  const cssW = Math.max(120, canvas.clientWidth || window.innerWidth || 800);
  const cssH = Math.max(120, canvas.clientHeight || window.innerHeight || 600);
  const w = clamp(Math.round(cssW / st.pixelSize), 120, 1200);
  const h = clamp(Math.round(cssH / st.pixelSize), 120, 1200);
  const world = Pond.world;
  const oldW = world.res.x;
  const oldH = world.res.y;
  if (!initial && oldW === w && oldH === h) return;

  Pond.gfx.resize(w, h);
  world.res.x = w;
  world.res.y = h;
  world.pond = createPond(world.res, world.rimTable);

  if (!initial && Pond.school) {
    // fish keep swimming, they just move with the new dimensions
    const kx = w / oldW;
    const ky = h / oldH;
    for (const k of world.koi) {
      k.x *= kx;
      k.y *= ky;
      for (const node of k.spine) {
        node.x *= kx;
        node.y *= ky;
      }
    }
    for (const school of world.minnows) {
      school.x *= kx;
      school.y *= ky;
      for (const m of school.fish) {
        m.x *= kx;
        m.y *= ky;
      }
    }
  }
  if (Pond.school) buildSceneryFor(world);
}

// ------------------------------------------------------------------ input

function screenToWorld(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  const cw = canvas.width;
  const ch = canvas.height;
  return {
    x: ((ev.clientX - rect.left) / rect.width) * cw,
    y: ((ev.clientY - rect.top) / rect.height) * ch,
  };
}

function pointerPos(canvas, x, y) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((x - rect.left) / rect.width) * canvas.width,
    y: ((y - rect.top) / rect.height) * canvas.height,
  };
}

function handleWaterClick(x, y) {
  const world = Pond.world;
  spawnRipple("touch", x, y, {});
  callFish(x, y);
  Sound.plop(0.9);
  // the little school bolts
  for (const school of world.minnows) {
    const d = Math.hypot(school.x - x, school.y - y);
    if (d < 150) {
      school.state = "dart";
      school.timer = 0.8;
      school.targetX = clamp(school.x - (x - school.x) * 0.8, 10, world.res.x - 10);
      school.targetY = clamp(school.y - (y - school.y) * 0.8, 10, world.res.y - 10);
    }
  }
}

function callFish(x, y) {
  const world = Pond.world;
  const call = world.call;
  call.x = x;
  call.y = y;
  call.age = 0;
  call.duration = 5.5;
  call.radius = Math.max(world.res.x, world.res.y) * 0.42;
  call.active = true;
  for (let i = 0; i < world.count; i++) {
    const k = world.koi[i];
    const d = Math.hypot(k.x - x, k.y - y);
    k.callDelay = 0.08 + (d / call.radius) * 0.7 + k.rand.unit() * 0.25 + (1 - k.reactivity) * 0.5;
    k.responded = false;
  }
}

function scatter() {
  const world = Pond.world;
  const rand = scatterRand;
  for (let i = 0; i < world.count; i++) {
    world.koi[i].scatter(rand, world.pond);
  }
  world.call.active = false;
  for (const school of world.minnows) {
    school.state = "dart";
    school.timer = 1.1;
    const p = world.pond.randomPoint(school.rand, 0.8, 0.2);
    school.targetX = p.x;
    school.targetY = p.y;
  }
  Sound.plop(0.7);
}

const scatterRand = new Rand(0x51ed270b);

function feed(x, y) {
  const world = Pond.world;
  for (let i = 0; i < 7; i++) {
    world.pellets.push({
      x: x + (Math.random() - 0.5) * 18,
      y: y + (Math.random() - 0.5) * 14,
      age: 0,
      eaten: false,
    });
  }
  spawnRipple("splash", x, y, {});
  Sound.plop(0.6);
}

function findPadAt(x, y) {
  const pads = Pond.scenery.pads;
  let best = null;
  let bestD = 1e9;
  for (const pad of pads) {
    const d = Math.hypot(pad.x - x, pad.y - y);
    if (d < pad.r + 4 && d < bestD) {
      best = pad;
      bestD = d;
    }
  }
  return best;
}

function handlePointerDown(x, y) {
  const st = Pond.state;
  st.pointer.down = true;
  st.pointer.x = x;
  st.pointer.y = y;
  const pad = findPadAt(x, y);
  if (pad) {
    pad.held = true;
    pad.grabX = pad.x - x;
    pad.grabY = pad.y - y;
    st.dragPad = pad;
    return;
  }
  handleWaterClick(x, y);
}

function handlePointerMove(x, y) {
  const st = Pond.state;
  const world = Pond.world;
  st.pointer.x = x;
  st.pointer.y = y;
  if (st.dragPad) {
    const pad = st.dragPad;
    const nx = clamp(x + pad.grabX, 4, world.res.x - 4);
    const ny = clamp(y + pad.grabY, 4, world.res.y - 4);
    const moved = Math.hypot(nx - pad.x, ny - pad.y);
    pad.x = nx;
    pad.y = ny;
    pad.driftX = 0;
    pad.driftY = 0;
    if (moved > 0.2 && world.time - st.lastWake > 0.11) {
      st.lastWake = world.time;
      spawnRipple("wake", pad.x, pad.y, { scale: 1.1 });
    }
    return;
  }
  if (!st.pointer.down) return;
  // dragging across open water: a line of small rings and a nudge to
  // whichever koi are right there
  const dx = x - st.lastDragSpawn.x;
  const dy = y - st.lastDragSpawn.y;
  if (Math.hypot(dx, dy) > 16) {
    st.lastDragSpawn.x = x;
    st.lastDragSpawn.y = y;
    spawnRipple("touch", x, y, { rings: 1, scale: 0.55 });
    for (let i = 0; i < world.count; i++) {
      const k = world.koi[i];
      const d = Math.hypot(k.x - x, k.y - y);
      if (d < 54) {
        k.fleeX = (k.x - x) / Math.max(d, 0.001);
        k.fleeY = (k.y - y) / Math.max(d, 0.001);
        k.fleeTimer = 0.5;
      }
    }
  }
}

function handlePointerUp() {
  const st = Pond.state;
  st.pointer.down = false;
  if (st.dragPad) {
    const pad = st.dragPad;
    pad.held = false;
    pad.homeX = clamp(pad.homeX, 8, Pond.world.res.x - 8);
    pad.homeY = clamp(pad.homeY, 8, Pond.world.res.y - 8);
    // letting go nudges the water once
    spawnRipple("splash", pad.x, pad.y, { scale: 0.9 });
    Sound.plop(0.5);
    st.dragPad = null;
  }
  st.lastDragSpawn.x = -999;
  st.lastDragSpawn.y = -999;
}

function setPixelSize(p) {
  const st = Pond.state;
  st.pixelSize = p;
  $("button.px[data-px]").removeClass("on");
  $('button.px[data-px="' + p + '"]').addClass("on");
  fit(false);
}

function handleKey(key) {
  const st = Pond.state;
  if (key === " ") {
    scatter();
    return true;
  }
  if (key === "[") return setKoiCount(st.koiCount - 2);
  if (key === "]") return setKoiCount(st.koiCount + 2);
  if (key === "1") return setPixelSize(6);
  if (key === "2") return setPixelSize(4);
  if (key === "3") return setPixelSize(3);
  if (key === "d") {
    st.showSpines = !st.showSpines;
    return true;
  }
  if (key === "h") {
    st.hidden = !st.hidden;
    $(".hud").toggleClass("hidden", st.hidden);
    return true;
  }
  if (key === "f") {
    feed(Pond.world.res.x * 0.5, Pond.world.res.y * 0.45);
    return true;
  }
  if (key === "r") {
    reseed();
    return true;
  }
  if (key === "s") {
    setSound(!st.sound);
    return true;
  }
  return false;
}

function installInput(canvas) {
  const st = Pond.state;

  $(canvas).on("pointerdown", (ev) => {
    const p = pointerPos(canvas, ev.clientX, ev.clientY);
    if (ev.shiftKey) {
      feed(p.x, p.y);
      return;
    }
    handlePointerDown(p.x, p.y);
  });
  $(window).on("pointermove", (ev) => {
    if (!st.pointer.down) return;
    const p = pointerPos(canvas, ev.clientX, ev.clientY);
    handlePointerMove(p.x, p.y);
  });
  $(window).on("pointerup pointercancel blur", () => handlePointerUp());

  $(document).on("keydown", (ev) => {
    if (handleKey(ev.key)) ev.preventDefault();
  });

  let resizeTimer = 0;
  $(window).on("resize orientationchange", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => fit(false), 120);
  });

  $("#btn-sound").on("click", () => setSound(!st.sound));
  $("#row-px").on("click", "button.px", function () {
    setPixelSize(parseInt($(this).attr("data-px"), 10));
  });
  $("#btn-koi").on("click", () => setKoiCount(st.koiCount + 2));
  $("#btn-koi-less").on("click", () => setKoiCount(st.koiCount - 2));

  // the hint line steps out of the way after a while
  window.setTimeout(() => {
    if (!st.hidden) {
      st.hidden = true;
      $(".hud").addClass("hidden");
    }
  }, 32000);
}

function setSound(on) {
  const st = Pond.state;
  st.sound = on;
  Sound.setEnabled(on);
  $("#btn-sound").text(on ? "sound: on" : "sound: off").toggleClass("on", on);
  if (on) Sound.plop(0.6);
}

function setKoiCount(n) {
  const st = Pond.state;
  const world = Pond.world;
  world.count = clamp(n, CONFIG.koi.minCount, CONFIG.koi.maxCount);
  CONFIG.koi.count = world.count;
  st.koiCount = world.count;
  // newly added fish arrive at the surface with a small splash
  for (let i = 0; i < world.count; i++) {
    const k = world.koi[i];
    if (!k.arrived) {
      k.arrived = true;
      k.place(new Rand(st.seed ^ (i + 1)), world.pond);
      spawnRipple("splash", k.x, k.y, { scale: 0.8 });
      k.depth = 0.05;
      k.depthTarget = 0.05;
    }
  }
}

function reseed() {
  const st = Pond.state;
  st.seed = (Math.random() * 0xffffffff) >>> 0;
  const world = Pond.world;
  const rand = new Rand(st.seed);
  for (let i = 0; i < world.koi.length; i++) {
    const k = world.koi[i];
    Pond.gfx.freeTexture(k.canvas);
    const fresh = new Koi(new Rand(st.seed ^ Math.imul(i + 1, 0x51ed270b)), world.pond, world.res, i, Pond.school.tally);
    Object.assign(k, {
      length: fresh.length, height: fresh.height, variety: fresh.variety,
      canvas: fresh.canvas, extents: fresh.extents, spineRow: fresh.spineRow,
      rand: fresh.rand, cruise: fresh.cruise, maxSpeed: fresh.maxSpeed,
      turnRate: fresh.turnRate,
    });
    k.mesh = Pond.gfx.createFishMesh(k.extents, SPINE_NODES, k.spineRow, k.height, k.length);
    k.x = world.pond.cx + rand.range(-40, 40);
    k.y = world.pond.cy + rand.range(-40, 40);
  }
  for (const school of world.minnows) {
    for (const m of school.fish) Pond.gfx.freeTexture(m.canvas);
  }
  Pond.world.minnows = createSchool(rand, world.pond, world.res).minnows;
  world.minnows = Pond.world.minnows;
  Pond.butterflies = createButterflies(new Rand(st.seed ^ 0x5bf03635), world.res);
  buildSceneryFor(world);
  resetWaterField();
  world.call.active = false;
}

// ------------------------------------------------------------------ loop

function simulate(dt) {
  const world = Pond.world;
  const time = world.time;
  const simWorld = {
    pond: world.pond,
    res: world.res,
    time,
    koi: world.koi,
    count: world.count,
    pellets: world.pellets,
    call: world.call,
    onGulp: world.onGulp,
  };
  world.call.age = world.call.active ? world.call.age + dt : 999;
  if (world.call.active && world.call.age > world.call.duration) world.call.active = false;

  for (let i = 0; i < world.count; i++) world.koi[i].update(dt, simWorld);
  for (const school of world.minnows) school.update(dt, simWorld);
  updatePads(dt, time, Pond.scenery.pads, world.pond);
  updateDuckweed(dt, time, Pond.scenery.duckweed, world.pond);
  updateClouds(dt, world.res, Pond.scenery.clouds);
  updateButterflies(dt, time, Pond.butterflies, { pond: world.pond, res: world.res, flowers: Pond.scenery.padFlowers });

  for (let i = world.pellets.length - 1; i >= 0; i--) {
    const p = world.pellets[i];
    p.age += dt;
    if (p.eaten || p.age > 40) world.pellets.splice(i, 1);
  }
  updateWaterField(dt);

  // demo mode: a couple of scripted ripples so a screenshot has something
  // to look at without anyone clicking
  if (Pond.state.demo) {
    Pond.state.demoTimer += dt;
    const stages = [0.5, 1.6, 3.0];
    if (Pond.state.demoStage < stages.length && Pond.state.demoTimer > stages[Pond.state.demoStage]) {
      const s = stages[Pond.state.demoStage];
      const x = world.res.x * (0.3 + 0.2 * Pond.state.demoStage);
      const y = world.res.y * (0.35 + 0.15 * Pond.state.demoStage);
      spawnRipple("touch", x, y, {});
      callFish(x, y);
      if (Pond.state.demoStage === 1) feed(x, y + 20);
      void s;
      Pond.state.demoStage++;
    }
  }
}

function drawFrame() {
  const gfx = Pond.gfx;
  const world = Pond.world;
  const time = world.time;
  const scenery = Pond.scenery;

  // ---- everything under the water surface ----
  gfx.bindTarget(gfx.targets.under);
  const b = CONFIG.bed;
  gfx.clear(b.deep[0] / 255, b.deep[1] / 255, b.deep[2] / 255);
  gfx.setPondFrame(world);
  gfx.drawBed(world);

  // shadows first, they live on the floor
  const blob = Pond.blobCanvas();
  const koiSorted = world.koi.slice(0, world.count).sort((a, c) => c.depth - a.depth);
  for (const k of koiSorted) {
    gfx.drawSprite(blob, k.x + 1.6 + k.depth * 2, k.y + 2.6 + k.depth * 3.5, k.length * 1.0, k.length * 0.45, k.heading,
      [0.05, 0.12, 0.15, CONFIG.shadows.koiAlpha[0] + k.depth * (CONFIG.shadows.koiAlpha[1] - CONFIG.shadows.koiAlpha[0])], false);
  }
  for (const pad of scenery.pads) {
    const bob = waterBobAt(pad.x, pad.y, time) * 0.6;
    gfx.drawSprite(blob, pad.x + 2, pad.y + 3 + bob * 0.4, pad.size * 0.98, pad.size * 0.86, pad.rot, [0.07, 0.15, 0.13, CONFIG.shadows.padAlpha], false);
  }
  for (const we of scenery.duckweed) {
    const bob = waterBobAt(we.x, we.y, time) * 0.5;
    gfx.drawSprite(blob, we.x + 1, we.y + 1.5 + bob * 0.4, 3, 2.4, 0, [0.08, 0.16, 0.14, 0.14], false);
  }

  // koi, deepest first so the shallow ones pass over the top
  for (const k of koiSorted) {
    const gulpPulse = k.gulpAnim > 0 ? 1 + Math.sin((0.4 - k.gulpAnim) / 0.4 * Math.PI) * 0.06 : 1;
    gfx.drawFish(k.mesh, k.canvas, k.spine, {
      texH: k.height,
      scale: k.depthScale() * gulpPulse,
      wavePhase: k.wavePhase || 0,
      waveAmp: k.length * (0.018 + (k.speed / k.maxSpeed) * 0.05) * k.waveAmpBase,
      waveK: 5.4,
      tint: [1, 1, 1, 1 - k.depth * 0.16],
      deepTint: k.depth * 0.45,
    });
  }

  // minnows ride just under the surface
  for (const school of world.minnows) {
    for (const m of school.fish) {
      gfx.drawFish(MeshCache.get(m.canvas, () => gfx.createFishMesh(
        m.extents, MINNOW_NODES, m.sprite.spineRow, m.canvas.height, m.canvas.width,
      )), m.canvas, m.spine, {
        texH: m.canvas.height,
        scale: 1,
        wavePhase: m.phase,
        waveAmp: 0.7,
        waveK: 4.2,
        tint: [1, 1, 1, 0.95],
        deepTint: 0.18,
      });
    }
  }

  // mossy stones standing in the shallows (under the surface, so the water
  // pass bends and tints them with everything else)
  for (const s of scenery.shore) {
    if (!s.submerged) continue;
    gfx.drawSprite(s.tex, s.x, s.y, s.w, s.h, s.rot, [0.86, 0.94, 0.94, 0.95], false);
  }

  // butterfly shadows and their faint reflection on the surface
  for (const bf of Pond.butterflies) {
    gfx.drawSprite(blob, bf.x + 1.5, bf.y + 2.4, 6, 4, 0, [0.08, 0.15, 0.13, CONFIG.shadows.butterflyAlpha], false);
    if (world.pond.d(bf.x, bf.y) < 0.94 && !bf.resting) {
      const wobble = waterBobAt(bf.x, bf.y, time) * 0.5;
      gfx.drawSprite(bf.canvas, bf.x, bf.y + 3.2 + wobble, bf.canvas.width, bf.canvas.height, bf.rot, [0.75, 0.85, 0.9, 0.16], true);
    }
  }

  // ---- the water surface pass, refracting everything above ----
  gfx.bindTarget(gfx.targets.scene);
  gfx.drawWater(world);

  // ---- floating things and the plants at the frame edge, crisp on top ----
  for (const s of scenery.shore) {
    if (s.submerged) continue;
    const y = s.anchor === "bottom" ? s.y - s.h * 0.5 : s.y;
    gfx.drawSprite(s.tex, s.x, y, s.w, s.h, s.rot, [1, 1, 1, 1], false);
  }
  for (const pad of scenery.pads) {
    const bob = waterBobAt(pad.x, pad.y, time) * 0.6;
    const s = pad.shade;
    gfx.drawSprite(pad.tex, pad.x, pad.y + bob, pad.size, pad.size, pad.rot, [s, s, s, 1], false);
  }
  for (const f of scenery.padFlowers) {
    const bob = waterBobAt(f.pad.x, f.pad.y, time) * 0.6;
    gfx.drawSprite(f.tex, f.x, f.pad.y + bob + (f.y - f.pad.y), f.size, f.size, f.rot, [1, 1, 1, 1], false);
  }
  for (const we of scenery.duckweed) {
    const bob = waterBobAt(we.x, we.y, time) * 0.5;
    const size = 3.4 * we.size;
    gfx.drawSprite(we.tex, we.x, we.y + bob, size, size * 0.8, we.rot, [1, 1, 1, 1], false);
  }
  for (const bf of Pond.butterflies) {
    gfx.drawSprite(bf.canvas, bf.x, bf.y, bf.canvas.width, bf.canvas.height, bf.rot, [1, 1, 1, 1], false);
  }
  for (const pellet of world.pellets) {
    const bob = waterBobAt(pellet.x, pellet.y, time) * 0.5;
    gfx.drawSprite(Pond.crumbCanvas(), pellet.x, pellet.y + bob, 3, 3, 0, [1, 1, 1, 1], false);
  }
  if (Pond.state.showSpines) gfx.drawSpinesDebug(world);

  gfx.present(world);
}

const MeshCache = {
  map: new Map(),
  get(canvas, make) {
    if (!this.map.has(canvas)) this.map.set(canvas, make());
    return this.map.get(canvas);
  },
};

let __blob = null;
Pond.blobCanvas = function () {
  if (!__blob) __blob = TEXTURES.paintBlob();
  return __blob;
};
let __crumb = null;
Pond.crumbCanvas = function () {
  if (!__crumb) {
    const { c, ctx } = TEXTURES.makeCanvas(3, 3);
    ctx.fillStyle = "#d8b264";
    ctx.fillRect(1, 1, 1, 1);
    ctx.fillStyle = "#b08c42";
    ctx.fillRect(0, 1, 1, 1);
    ctx.fillRect(1, 0, 1, 1);
    ctx.fillStyle = "#eed9a0";
    ctx.fillRect(2, 1, 1, 1);
    __crumb = c;
  }
  return __crumb;
};

let lastFrame = 0;
function frame(now) {
  const world = Pond.world;
  if (!lastFrame) lastFrame = now;
  let dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  // fixed-step simulation at 60 Hz
  const FIXED = 1 / 60;
  if (!Pond.state.freeze) {
    world.acc = (world.acc || 0) + dt;
    let steps = 0;
    while (world.acc >= FIXED && steps < 4) {
      world.time += FIXED;
      simulate(FIXED);
      world.acc -= FIXED;
      steps++;
    }
    if (world.acc > FIXED * 6) world.acc = 0;
  }

  drawFrame();

  const st = Pond.state;
  st.frames++;
  st.fpsClock += dt;
  if (st.fpsClock >= 1) {
    st.fps = Math.round(st.frames / st.fpsClock);
    st.frames = 0;
    st.fpsClock = 0;
  }
  requestAnimationFrame(frame);
}

$(function () {
  try {
    boot();
  } catch (err) {
    if (window.__showErr) window.__showErr(err && err.message ? err.message : String(err));
    throw err;
  }
});

// make the helpers visible to __showErr's closure target
window.__showErr = window.__showErr || function (msg) {
  window.__errs.push(String(msg));
};
