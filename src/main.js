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
  for (const k of world.koi) k.spineTex = gfx.makeSpineTex();
  for (const school of world.minnows) {
    for (const m of school.fish) m.spineTex = gfx.makeSpineTex();
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
    padIndexOf: (pad) => padIndexOf(pad),
    hitGrid: (i, step, span) => hitGrid(i, step || 3, span || 36),
    grabSelfTest: () => grabSelfTest(),
    pointerScale: () => pointerScale(canvas),
    selectedPad: () => (Pond.state.selPad
      ? { x: +Pond.state.selPad.x.toFixed(1), y: +Pond.state.selPad.y.toFixed(1), r: Pond.state.selPad.r }
      : null),
    probes: () => probeReport(),
    clearProbes: () => probeClear(),
    probeToggle: () => {
      PROBE.on = !PROBE.on;
      return PROBE.on;
    },
    probeMarkers: (on) => {
      PROBE.on = on === undefined ? !PROBE.on : !!on;
      return PROBE.on;
    },
    scenery: () =>
      Pond.scenery.pads.map((p) => {
        let px = null;
        try {
          const g = p.tex.getContext("2d");
          const d = g.getImageData(Math.floor(p.tex.width / 2), Math.floor(p.tex.height / 2), 1, 1).data;
          px = [d[0], d[1], d[2], d[3]];
        } catch (e) {
          px = "ERR:" + e.message;
        }
        return {
          x: +p.x.toFixed(1), y: +p.y.toFixed(1), size: p.size, r: p.r,
          shade: p.shade === undefined ? "undefined" : p.shade,
          held: !!p.held, rot: +p.rot.toFixed(2), tex: p.tex ? [p.tex.width, p.tex.height] : null,
          centrePixel: px, home: [p.homeX, p.homeY],
        };
      }),
    moss: () =>
      Pond.scenery.surfaceMoss.map((m) => ({
        x: +m.x.toFixed(1), y: +m.y.toFixed(1), size: +m.size.toFixed(1), held: !!m.held,
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
    spawnAt: (x, y, kind, scale, sign) => {
      spawnRipple(kind || "touch", x, y, { scale: scale === undefined ? 1 : scale, sign });
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
    // and the scenery has to move with them. Without this the pads keep their
    // old coordinates while the world changes size, so every pad drifts off
    // the spot you can see and presses land on water.
    if (kx !== 1 || ky !== 1) {
      const scale = (o) => {
        if (typeof o.x === "number") o.x *= kx;
        if (typeof o.y === "number") o.y *= ky;
        if (typeof o.homeX === "number") o.homeX *= kx;
        if (typeof o.homeY === "number") o.homeY *= ky;
        if (typeof o.driftX === "number") o.driftX = 0;
        if (typeof o.driftY === "number") o.driftY = 0;
      };
      for (const pad of Pond.scenery.pads) scale(pad);
      for (const f of Pond.scenery.padFlowers) scale(f);
      for (const m of Pond.scenery.surfaceMoss) scale(m);
      for (const d of Pond.scenery.duckweed) scale(d);
      for (const wd of Pond.scenery.weeds) scale(wd);
      for (const sh of Pond.scenery.shore) scale(sh);
    }
    pointerScale(Pond.gfx.canvas);
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
  // build the scenery once. Rebuilding it on every resize re-rolled the random
  // generator, so all the pads jumped to brand new spots each time the window
  // changed size: you would aim at a pad you could still see and press water.
  if (Pond.school && !Pond.__sceneryBuilt) {
    Pond.__sceneryBuilt = true;
    buildSceneryFor(world);
  }
}

// ------------------------------------------------------------------ input

// THE one screen-to-world conversion. Everything that needs to know where the
// pointer is uses this, and it takes its scale from the same world resolution
// the renderer draws with, so the two cannot disagree. The old version mixed
// the canvas rectangle's ratio with raw canvas pixels and never divided by the
// pixel size; it only worked when the backing store happened to equal the CSS
// size, which is exactly the kind of accident that hides for hours.
function pointerScale(canvas) {
  const rect = canvas.getBoundingClientRect();
  const res = (Pond.world && Pond.world.res) || { x: canvas.width, y: canvas.height };
  Pond.state.kx = res.x / rect.width;
  Pond.state.ky = res.y / rect.height;
  Pond.state.rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  return Pond.state.rect;
}

function pointerPos(canvas, x, y) {
  const rect = Pond.state.rect || pointerScale(canvas);
  const res = (Pond.world && Pond.world.res) || { x: canvas.width, y: canvas.height };
  // Each axis gets its own ratio. The renderer scales y by res.y / viewport
  // height, and using the x ratio for y was off by 8 percent on a non-square
  // window, which is about one pad radius at mid screen: presses near a pad's
  // centre just barely landed, and everything else missed.
  return {
    x: (x - rect.left) * (res.x / rect.width),
    y: (y - rect.top) * (res.y / rect.height),
  };
}

// Boot check. Round trips the pointer conversion through world and back, then
// asks the hit test for a pad at its centre and near its rim. If any of it
// fails it says so on screen with the numbers, because a silent coordinate
// mismatch is what ate a whole day of this.
function grabSelfTest() {
  if (!CONFIG.pads.grabbable) {
    const el = document.getElementById("grab-warning");
    if (el) el.remove();
    return { ok: true, checks: ["grabbing is off: pads are scenery"] };
  }
  const canvas = document.getElementById("pond");
  const pads = Pond.scenery.pads;
  const report = { ok: true, checks: [] };
  if (!pads.length) return { ok: false, checks: ["no pads"] };
  const rect = pointerScale(canvas);
  const res = Pond.world.res;
  const pad = pads[0];
  const cssX = rect.left + pad.x * (rect.width / res.x);
  const cssY = rect.top + pad.y * (rect.height / res.y);
  const back = pointerPos(canvas, cssX, cssY);
  const err = Math.hypot(back.x - pad.x, back.y - pad.y);
  report.checks.push({ what: "pointer round trip", errorPx: +err.toFixed(2), pass: err < 1 });
  if (err >= 1) report.ok = false;
  const half = pad.size * 0.5;
  const centreHit = findPadAt(pad.x, pad.y, 1.0);
  const centre = centreHit === pad;
  // near the rim a neighbouring pad can legitimately be nearer, so the only
  // thing that must hold is that SOME pad answers. Requiring this exact pad
  // here was the test's own bug, not the grab's.
  const rim = [0, 90, 180, 270].map((a) => {
    const rad = (a * Math.PI) / 180;
    const hit = findPadAt(pad.x + Math.cos(rad) * half * 0.85, pad.y + Math.sin(rad) * half * 0.85, 1.0);
    return { angle: a, pass: hit !== null, samePad: hit === pad };
  });
  report.checks.push({ what: "hit test at centre", pass: centre });
  report.checks.push({ what: "hit test near rim", pass: rim.every((r) => r.pass), detail: rim });
  if (!centre || !rim.every((r) => r.pass)) report.ok = false;

  let el = document.getElementById("grab-warning");
  if (!report.ok) {
    if (!el) {
      el = document.createElement("div");
      el.id = "grab-warning";
      el.style.cssText = "position:fixed;left:10px;bottom:110px;z-index:90;pointer-events:none;"
        + "font:12px/1.5 ui-monospace,Menlo,monospace;color:#ffe9e9;background:rgba(120,16,16,.86);"
        + "padding:8px 11px;border-radius:6px;white-space:pre";
      document.body.appendChild(el);
    }
    el.textContent = "GRAB SELF TEST FAILED\n"
      + "round trip error " + err.toFixed(2) + " world px\n"
      + "centre " + (centre ? "ok" : "DEAD") + "  rim " + rim.filter((r) => !r.pass).map((r) => r.angle + " deg").join(",") + " DEAD\n"
      + "rect " + Math.round(rect.width) + "x" + Math.round(rect.height) + "  world " + res.x + "x" + res.y;
  } else if (el) {
    el.remove();
  }
  return report;
}

// A live map of where a pad answers to a press, point by point, so the grab
// area can be compared against the paint instead of assumed.
function hitGrid(padIndex, step, span) {
  const pads = Pond.scenery.pads;
  const pad = pads[padIndex];
  if (!pad) return null;
  const out = { pad: padIndex, size: pad.size, r: pad.r, step: step, cells: [] };
  for (let dy = -span; dy <= span; dy += step) {
    let row = "";
    for (let dx = -span; dx <= span; dx += step) {
      const hit = findPadAt(pad.x + dx, pad.y + dy, 1.0) === pad;
      row += hit ? "#" : ".";
    }
    out.cells.push(row);
  }
  out.note = "# means a press here takes this pad";
  return out;
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

// Where a pad actually is on screen includes its bob. Drawing and grabbing must
// use the same number, and the bob is capped so the two can never drift apart
// into a big invisible grab area next to the pad you can see.
function padBobAt(pad, time) {
  return clamp(waterBobAt(pad.x, pad.y, time) * 0.6, -1.2, 1.2);
}

// slack is how forgiving the grab is: 1 is the pad's own disc
function findPadAt(x, y, slack) {
  // one switch, and the whole grab apparatus is off: press, hover, sweep,
  // drag and the keyboard nudge all go through here or check this flag
  if (!CONFIG.pads.grabbable) return null;
  const reach = slack === undefined ? 1.05 : slack;
  const pads = Pond.scenery.pads;
  let best = null;
  let bestD = 1e9;
  for (const pad of pads) {
    const py = pad.y + padBobAt(pad, Pond.world.time);
    const d = Math.hypot(pad.x - x, py - y);
    // the sprite is drawn pad.size wide, so the pad you see reaches size/2 in
    // every direction. The physics radius is about a third of that, which is
    // why pressing the outer half of a lily pad did nothing: the grab area was
    // a small dot in the middle of it. This is the drawn extent, plus three.
    if (d <= pad.size * 0.5 + 3 && d < bestD) {
      best = pad;
      bestD = d;
    }
  }
  // moss mats are scenery: they drift, they get pushed by the water, and
  // they are never grabbable, so a mat can never steal a pad's grab again
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
    const px = st.pixelSize;
    // The pad simply moves by the cursor's own screen delta, step by step.
    // Nothing is reconstructed from a stored anchor, so there is no arithmetic
    // left that could send the pad the other way: whatever direction the
    // cursor travelled on screen is the direction the pad travels.
    const css = st.pointerCss || [x * px, y * px];
    const last = st.lastDragCss || css;
    const nx = clamp(pad.x + (css[0] - last[0]) / px, 4, world.res.x - 4);
    const ny = clamp(pad.y + (css[1] - last[1]) / px, 4, world.res.y - 4);
    pad.grabX = pad.x - x;
    pad.grabY = pad.y - y;
    st.lastDragCss = [css[0], css[1]];
    probeDragSample(css[0], css[1], x, y, pad);
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
  // a drag is in flight and a pad is under the pointer: take it. If a grab
  // ever gets lost, the pad must not start moving against your hand; instead
  // the pointer keeps hold of whatever pad it is over.
  const under = findPadAt(x, y, 1.3);
  if (under) {
    under.held = true;
    under.grabX = under.x - x;
    under.grabY = under.y - y;
    under.grabScreen = [under.x * st.pixelSize, under.y * st.pixelSize];
    st.grabCssAt = st.pointerCss || [x * st.pixelSize, y * st.pixelSize];
    st.dragPad = under;
    probeDragStart(st.pointerCss ? st.pointerCss[0] : x, st.pointerCss ? st.pointerCss[1] : y, x, y, under);
    return;
  }
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

// the shadow of everything falls away from the sun, at one angle
function shadowOffset(mag) {
  const dir = CONFIG.shadows.dir;
  return [dir[0] * mag, dir[1] * mag];
}

const SHADOW_TINT = CONFIG.shadows.tint;

function handlePointerUp() {
  const st = Pond.state;
  st.pointer.down = false;
  if (st.dragPad) {
    const pad = st.dragPad;
    pad.held = false;
    // a pad you move stays where you put it: its home becomes the drop spot,
    // otherwise it slides back and the drag reads as backwards
    pad.homeX = clamp(pad.x, 8, Pond.world.res.x - 8);
    pad.homeY = clamp(pad.y, 8, Pond.world.res.y - 8);
    pad.driftX = 0;
    pad.driftY = 0;
    pad.vx = 0;
    pad.vy = 0;
    pad.grabScreen = null;
    st.grabCssAt = null;
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

Pond.__probeToggle = () => {
  PROBE.on = !PROBE.on;
  return PROBE.on;
};

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
  if (key === "p") return Pond.__probeToggle();
  // keyboard pad control: no pointer involved, so nothing on screen can
  // intercept it
  if (!CONFIG.pads.grabbable) return false;
  if (key === "," || key === ".") {
    const pads = Pond.scenery.pads;
    if (!pads.length) return true;
    let i = pads.indexOf(st.selPad);
    i = i < 0 ? 0 : (i + (key === "." ? 1 : -1) + pads.length) % pads.length;
    st.selPad = pads[i];
    Sound.plop(0.25);
    return true;
  }
  if (key.indexOf("Arrow") === 0) {
    const pad = st.selPad || Pond.scenery.pads[0];
    if (!pad) return false;
    const step = 2;
    if (key === "ArrowLeft") pad.x = clamp(pad.x - step, 4, Pond.world.res.x - 4);
    if (key === "ArrowRight") pad.x = clamp(pad.x + step, 4, Pond.world.res.x - 4);
    if (key === "ArrowUp") pad.y = clamp(pad.y - step, 4, Pond.world.res.y - 4);
    if (key === "ArrowDown") pad.y = clamp(pad.y + step, 4, Pond.world.res.y - 4);
    pad.homeX = pad.x;
    pad.homeY = pad.y;
    pad.driftX = 0;
    pad.driftY = 0;
    st.selPad = pad;
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

// ---------------------------------------------------------------- probes
// Every click is recorded with both the screen position and the backing
// position it resolved to, and every ripple is tracked to see whether it
// actually advances and where it lands. window.__pond.probes.report() reads
// the lot back. Markers on screen show a click and where its ripple went:
// cyan where you clicked, green where the ripple landed, red if they differ.
const PROBE = {
  on: true,
  max: 240,
  clicks: [],
  ripples: [],
  stuck: [],
  mismatches: [],
  watch: [],
  trace: [],
  divergence: [],
  counters: { clicks: 0, ripples: 0, grabbed: 0, fed: 0, water: 0, mismatch: 0, stuck: 0 },
};
PROBE.noteRipple = probeRipple;
window.__probes = PROBE;

function probePush(list, rec) {
  list.push(rec);
  if (list.length > PROBE.max) list.splice(0, list.length - PROBE.max);
}

function probeMark(cssX, cssY, color) {
  const d = document.createElement("div");
  d.className = "probe-mark";
  d.style.cssText = "position:fixed;pointer-events:none;z-index:60;border-radius:50%;"
    + "left:" + (cssX - 10) + "px;top:" + (cssY - 10) + "px;width:20px;height:20px;"
    + "border:1px solid " + color + ";opacity:1;transition:opacity .6s linear";
  document.body.appendChild(d);
  window.setTimeout(() => { d.style.opacity = "0"; }, 700);
  window.setTimeout(() => d.remove(), 1500);
}

function probeClick(kind, cssX, cssY, worldX, worldY, extra) {
  const rec = {
    t: +Pond.world.time.toFixed(2),
    kind,
    css: [Math.round(cssX), Math.round(cssY)],
    world: [+worldX.toFixed(1), +worldY.toFixed(1)],
    ...extra,
  };
  probePush(PROBE.clicks, rec);
  PROBE.counters.clicks++;
  PROBE.counters[kind] = (PROBE.counters[kind] || 0) + 1;
  if (PROBE.on) probeMark(cssX, cssY, "rgba(90,210,255,.85)");
  return rec;
}

// called by the ripple system for every ripple it spawns
function probeRipple(kind, x, y, n) {
  const rec = {
    t: +Pond.world.time.toFixed(2),
    kind,
    world: [+x.toFixed(1), +y.toFixed(1)],
    n,
    maxRadius: 0,
    maxP: 0,
    advancing: false,
    done: false,
    stuck: false,
  };
  probePush(PROBE.ripples, rec);
  PROBE.counters.ripples++;
  PROBE.watch.push(rec);
  if (PROBE.watch.length > 24) PROBE.watch.shift();
  if (PROBE.on && (kind === "touch" || kind === "splash")) {
    const last = PROBE.clicks[PROBE.clicks.length - 1];
    const px = Pond.state.pixelSize;
    // the click that caused this ripple should be the one right before it
    const mismatch = !!(last && last.kind === "water"
      && Math.hypot(last.world[0] - x, last.world[1] - y) > 2);
    probeMark(x * px, y * px, mismatch ? "rgba(255,90,90,.95)" : "rgba(140,255,170,.9)");
  }
  return rec;
}

// a ripple whose progress stops dead is a stalled jQuery job, not a slow wave
function probeTick() {
  // the grab self test runs itself once, shortly after the first frames, and
  // puts a red banner on screen with the numbers if anything is off
  if (!PROBE.selfTested && Pond.world.time > 1.5) {
    PROBE.selfTested = true;
    grabSelfTest();
  }
  probeReadout();
  const held = Pond.state.dragPad;
  if (held && Pond.world.time - (PROBE.lastDivT || 0) > 0.4) {
    PROBE.lastDivT = Pond.world.time;
    padDivergenceCheck(held);
  }
  if (!PROBE.watch.length) return;
  for (const rec of PROBE.watch) {
    if (rec.done) continue;
    const live = WATER_FIELD.rings.filter((r) => r.spawnRec === rec);
    if (!live.length) {
      rec.done = true;
      continue;
    }
    let advanced = false;
    let stalled = false;
    for (const r of live) {
      if (r.radius > rec.maxRadius) rec.maxRadius = +r.radius.toFixed(1);
      if (!r.armed) continue;                  // still waiting out its stagger
      if (r.probeP === undefined) r.probeP = -1;
      if (r.p > r.probeP + 0.0004) {
        advanced = true;
        r.probeP = r.p;
        r.probeStill = 0;
      } else {
        r.probeStill = (r.probeStill || 0) + 1;
        // half a second of frames without the ring moving at all is a stall
        if (r.probeStill > 30) stalled = true;
      }
    }
    rec.advancing = advanced;
    if (stalled && !rec.stuck) {
      rec.stuck = true;
      PROBE.counters.stuck++;
      probePush(PROBE.stuck, { kind: rec.kind, world: rec.world, at: rec.t, radius: rec.maxRadius });
    }
  }
}

// ---- full input recorder ------------------------------------------------
// Every pointer event, what it hit, and, crucially, where the pad being
// dragged is actually DRAWN (measured from the pixels) versus where the
// simulation thinks it is. Those two diverging is invisible to every test
// that only reads the model, which is how this bug hid for so long.
// The page draws its own pointer ring. A desktop pet sitting on the arrow
// hides the one the OS draws, and then you aim with the pet, which lags and
// hangs below the real pointer. This ring is always exactly where the pointer
// the canvas sees is, so you aim with the ring.
function markPointer(cssX, cssY) {
  let el = document.getElementById("pointer-ring");
  if (!el) {
    el = document.createElement("div");
    el.id = "pointer-ring";
    el.style.cssText = "position:fixed;width:84px;height:84px;margin:-42px 0 0 -42px;border-radius:50%;"
      + "border:2px solid rgba(255,255,255,.85);box-shadow:0 0 0 1px rgba(0,0,0,.35) inset;"
      + "pointer-events:none;z-index:80;mix-blend-mode:difference;transition:transform .06s linear";
    document.body.appendChild(el);
  }
  el.style.left = cssX + "px";
  el.style.top = cssY + "px";
}

function probeTrace(type, cssX, cssY, extra) {
  if (PROBE.trace.length > 300) PROBE.trace.shift();
  PROBE.trace.push({ t: +Pond.world.time.toFixed(2), type: type, css: [Math.round(cssX), Math.round(cssY)], extra: extra || null });
  PROBE.counters.events = (PROBE.counters.events || 0) + 1;
}

function padIndexOf(pad) {
  return Pond.scenery.pads.indexOf(pad);
}

function padDrawnCentre(pad) {
  const g = Pond.gfx, gl = g.gl;
  if (!PROBE.pxa) PROBE.pxa = new Uint8Array(4);
  const pxa = PROBE.pxa;
  let sx = 0, sy = 0, n = 0;
  gl.bindFramebuffer(gl.FRAMEBUFFER, g.targets.scene.fbo);
  for (let dy = -22; dy <= 22; dy += 2) {
    for (let dx = -22; dx <= 22; dx += 2) {
      const x = Math.round(pad.x + dx), y = Math.round(g.height - 1 - (pad.y + dy));
      if (x < 0 || y < 0 || x >= g.width || y >= g.height) continue;
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pxa);
      if (pxa[1] > pxa[0] + 10 && pxa[1] > pxa[2] + 18) { sx += x; sy += y; n++; }
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (n < 12) return { x: null, y: null, pixels: n };
  return { x: sx / n, y: g.height - 1 - sy / n, pixels: n };
}

function padDivergenceCheck(pad) {
  const drawn = padDrawnCentre(pad);
  if (drawn.x === null) {
    PROBE.lastDiv = { paintedPixelsNearModel: drawn.pixels, note: "no pad painted where the simulation says it is" };
    if (PROBE.divergence.length < 40) {
      probePush(PROBE.divergence, { t: +Pond.world.time.toFixed(2), pad: padIndexOf(pad), note: "no green found at the pad's model position", drawnPixels: drawn.pixels });
    }
    return;
  }
  const dx = drawn.x - pad.x, dy = drawn.y - pad.y, d = Math.hypot(dx, dy);
  PROBE.lastDiv = {
    d: +d.toFixed(1), dx: +dx.toFixed(1), dy: +dy.toFixed(1),
    model: [+pad.x.toFixed(1), +pad.y.toFixed(1)], drawn: [+drawn.x.toFixed(1), +drawn.y.toFixed(1)], pixels: drawn.pixels,
  };
  if (d > 6 && PROBE.divergence.length < 40) {
    probePush(PROBE.divergence, { t: +Pond.world.time.toFixed(2), pad: padIndexOf(pad), d: +d.toFixed(1), dx: +dx.toFixed(1), dy: +dy.toFixed(1) });
  }
}

function probeReadout() {
  let el = document.getElementById("probe-readout");
  if (!PROBE.on) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "probe-readout";
    el.style.cssText = "position:fixed;left:10px;top:10px;z-index:70;pointer-events:none;"
      + "font:11px/1.5 ui-monospace,Menlo,monospace;color:#e9e3d2;background:rgba(10,24,30,.72);"
      + "padding:6px 9px;border-radius:6px;white-space:pre";
    document.body.appendChild(el);
  }
  const last = PROBE.trace[PROBE.trace.length - 1];
  const held = Pond.state.dragPad ? padIndexOf(Pond.state.dragPad) : null;
  const d = PROBE.lastDiv;
  el.textContent =
    "events " + (PROBE.counters.events || 0) + "  held pad " + (held === null ? "-" : held) + "\n"
    + "last " + (last ? last.type + " @ " + last.css.join(",") : "-") + "\n"
    + "drawn vs model " + (d && d.d ? d.d + "px (" + d.dx + "," + d.dy + ")" : "-");
}

function probeDragStart(cssX, cssY, worldX, worldY, pad) {
  PROBE.drag = {
    t: +Pond.world.time.toFixed(2),
    grabCss: [Math.round(cssX), Math.round(cssY)],
    grabWorld: [+worldX.toFixed(1), +worldY.toFixed(1)],
    padStart: [+pad.x.toFixed(1), +pad.y.toFixed(1)],
    padKindR: pad.r,
    samples: [],
    end: null,
  };
  PROBE.counters.drags = (PROBE.counters.drags || 0) + 1;
}

function probeDragSample(cssX, cssY, worldX, worldY, pad) {
  const d = PROBE.drag;
  if (!d || d.samples.length > 40) return;
  d.samples.push({
    css: [Math.round(cssX), Math.round(cssY)],
    world: [+worldX.toFixed(1), +worldY.toFixed(1)],
    pad: [+pad.x.toFixed(1), +pad.y.toFixed(1)],
  });
}

function probeDragEnd() {
  const d = PROBE.drag;
  if (!d) return;
  d.end = { t: +Pond.world.time.toFixed(2) };
  const px = Pond.state.pixelSize;
  if (d.samples.length > 1) {
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const cursorDown = last.css[1] - first.css[1];
    const padDown = (last.pad[1] - first.pad[1]) * px;
    d.cursorMoved = cursorDown;
    d.padMovedOnScreen = +padDown.toFixed(1);
    d.sameDirection = Math.sign(cursorDown) === Math.sign(padDown) || Math.abs(cursorDown) < 4;
    const dist = Math.hypot(d.grabWorld[0] - d.padStart[0], d.grabWorld[1] - d.padStart[1]);
    d.grabbedTheRightPad = dist <= d.padKindR + 3;
    d.grabDistance = +dist.toFixed(1);
  }
}

function probeMismatch(kind, x, y) {
  const last = PROBE.clicks[PROBE.clicks.length - 1];
  if (!last || last.kind !== "water") return;
  const d = Math.hypot(last.world[0] - x, last.world[1] - y);
  if (d > 2) {
    PROBE.counters.mismatch++;
    probePush(PROBE.mismatches, { kind, click: last.world, ripple: [+x.toFixed(1), +y.toFixed(1)], d: +d.toFixed(1) });
  }
}

function probeReport() {
  const tail = (arr, n) => arr.slice(-n);
  return {
    counters: { ...PROBE.counters },
    markers: PROBE.on,
    lastClicks: tail(PROBE.clicks, 8),
    lastRipples: tail(PROBE.ripples, 8).map((r) => ({
      kind: r.kind, world: r.world, n: r.n, maxRadius: r.maxRadius, advanced: r.advancing, stuck: r.stuck,
    })),
    events: PROBE.counters.events || 0,
    moves: PROBE.counters.moves || 0,
    lastTrace: tail(PROBE.trace, 40),
    divergence: tail(PROBE.divergence, 12),
    lastDiv: PROBE.lastDiv || null,
    lastTouches: tail(PROBE.ripples.filter((r) => r.kind === "touch" || r.kind === "splash"), 6).map((r) => ({
      kind: r.kind, world: r.world, n: r.n, maxRadius: r.maxRadius, advanced: r.advancing, stuck: r.stuck, done: r.done,
    })),
    lastDrag: PROBE.drag && PROBE.drag.samples.length
      ? {
        grabCss: PROBE.drag.grabCss, grabWorld: PROBE.drag.grabWorld, padStart: PROBE.drag.padStart,
        samples: PROBE.drag.samples.length > 10
          ? PROBE.drag.samples.filter((_, i) => i % Math.ceil(PROBE.drag.samples.length / 10) === 0)
          : PROBE.drag.samples,
        cursorMovedOnScreen: PROBE.drag.cursorMoved,
        padMovedOnScreen: PROBE.drag.padMovedOnScreen,
        sameDirection: PROBE.drag.sameDirection,
        grabbedTheRightPad: PROBE.drag.grabbedTheRightPad,
        grabDistance: PROBE.drag.grabDistance,
      }
      : null,
    mismatches: tail(PROBE.mismatches, 8),
    stuck: tail(PROBE.stuck, 8),
  };
}

function probeClear() {
  PROBE.clicks.length = 0;
  PROBE.ripples.length = 0;
  PROBE.stuck.length = 0;
  PROBE.mismatches.length = 0;
  PROBE.watch.length = 0;
  PROBE.counters = { clicks: 0, ripples: 0, grabbed: 0, fed: 0, water: 0, mismatch: 0, stuck: 0 };
}

function installInput(canvas) {
  const st = Pond.state;

  $(canvas).on("pointerdown", (ev) => {
    const p = pointerPos(canvas, ev.clientX, ev.clientY);
    if (ev.shiftKey) {
      feed(p.x, p.y);
      probeClick("feed", ev.clientX, ev.clientY, p.x, p.y, {});
      return;
    }
    handlePointerDown(p.x, p.y);
    if (st.dragPad) {
      // say so out loud: the pad lifts a little and the water answers, so a
      // tap or a still hold is not silently ignored
      st.dragPad.lift = 1;
      spawnRipple("splash", st.dragPad.x, st.dragPad.y, { scale: 0.55 });
      Sound.plop(0.35);
    }
    if (st.dragPad) {
      // anchor the drag in screen space: where the pad is on screen and where
      // the cursor is. From here the pad moves by the cursor's screen delta,
      // so no world-space convention can turn the movement against your hand.
      st.lastDragCss = [ev.clientX, ev.clientY];
    }
    probeTrace("down", ev.clientX, ev.clientY, st.dragPad
      ? { hit: "pad " + padIndexOf(st.dragPad), grabDistance: +Math.hypot(st.dragPad.x - p.x, st.dragPad.y - p.y).toFixed(1) }
      : { hit: "water" });
    probeClick(st.dragPad ? "grab" : "water", ev.clientX, ev.clientY, p.x, p.y,
      st.dragPad ? { grabbed: [+st.dragPad.x.toFixed(1), +st.dragPad.y.toFixed(1)] } : {});
    if (st.dragPad) probeDragStart(ev.clientX, ev.clientY, p.x, p.y, st.dragPad);
  });
  $(window).on("pointermove", (ev) => {
    // where the real pointer actually is, so a pad can light up under it. With
    // a big cursor-following pet on screen this is the only honest readout of
    // your pointer position.
    // counted before any early return: this is the number that says whether
    // this page is seeing your pointer at all
    PROBE.counters.moves = (PROBE.counters.moves || 0) + 1;
    const hp = pointerPos(canvas, ev.clientX, ev.clientY);
    st.pointer.x = hp.x;
    st.pointer.y = hp.y;
    st.hoverPad = st.dragPad || findPadAt(hp.x, hp.y, 1.0);
    // if the button is down but this page never saw a press, something above
    // the page ate it. Sweep onto a pad with the button held and you take it.
    if (!st.dragPad && !st.pointer.down && ev.buttons === 1) {
      const sweep = findPadAt(hp.x, hp.y, 1.0);
      if (sweep) {
        st.dragPad = sweep;
        sweep.held = true;
        st.lastDragCss = [Math.round(ev.clientX), Math.round(ev.clientY)];
        probeDragStart(ev.clientX, ev.clientY, hp.x, hp.y, sweep);
        probeTrace("sweep grab", ev.clientX, ev.clientY, { pad: padIndexOf(sweep) });
        Sound.plop(0.3);
      }
    }
    // and if the button came up somewhere this page could not see, let go
    if (st.dragPad && ev.buttons === 0) {
      if (st.dragPad) padDivergenceCheck(st.dragPad);
      probeDragEnd();
      handlePointerUp();
      return;
    }
    if (!st.pointer.down && !st.dragPad) return;
    const p = pointerPos(canvas, ev.clientX, ev.clientY);
    st.pointerCss = [Math.round(ev.clientX), Math.round(ev.clientY)];
    if (st.dragPad) {
      probeTrace("move (held)", ev.clientX, ev.clientY, { pad: padIndexOf(st.dragPad), padModelAt: [+st.dragPad.x.toFixed(1), +st.dragPad.y.toFixed(1)] });
    }
    handlePointerMove(p.x, p.y);
  });
  // only a real pointerup ends a drag; a cancel keeps the pad in hand until
  // the pointer comes back, because a mouse drag can cancel for many reasons
  $(window).on("pointerup", (ev) => {
    const last = PROBE.clicks[PROBE.clicks.length - 1];
    if (last && ev && ev.clientX !== undefined && !last.up) {
      const up = pointerPos(document.getElementById("pond"), ev.clientX, ev.clientY);
      last.up = [+up.x.toFixed(1), +up.y.toFixed(1)];
    }
    probeTrace("up", ev && ev.clientX !== undefined ? ev.clientX : -1, ev && ev.clientY !== undefined ? ev.clientY : -1, { pad: st.dragPad ? padIndexOf(st.dragPad) : null });
    if (st.dragPad) padDivergenceCheck(st.dragPad);
    probeDragEnd();
    handlePointerUp();
  });

  // a native drag or a text selection cancels the pointer halfway through a
  // pad drag, which drops the pad and leaves you stirring water instead
  $(canvas).on("dragstart", (ev) => ev.preventDefault());
  $(canvas).on("selectstart", (ev) => ev.preventDefault());

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
  updateDuckweed(dt, time, Pond.scenery.surfaceMoss, world.pond, 0.5);
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
  // each koi casts its own silhouette on the floor
  for (const k of koiSorted) {
    const a = k.aabb;
    const off = 1.9 + k.depth * 3.4;
    const so = shadowOffset(off);
    const alpha = CONFIG.shadows.koiAlpha[0] + k.depth * (CONFIG.shadows.koiAlpha[1] - CONFIG.shadows.koiAlpha[0]);
    gfx.drawFish({
      canvas: k.canvas, extents: k.extents, spineTex: k.spineTex,
      spineData: k.spineData, spineN: SPINE_NODES,
      spriteW: k.length, spriteH: k.height, vc: k.spineRow / k.height,
      scale: 1,
      x: (a.minX + a.maxX) / 2 + so[0], y: (a.minY + a.maxY) / 2 + so[1],
      w: (a.maxX - a.minX) + 12, h: (a.maxY - a.minY) + 12,
      offset: [-so[0], -so[1]],
      tint: [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], alpha],
      deepTint: 0,
    });
  }
  // Pad shadows used to be drawn down here, under the water, which meant the
  // water's refraction could slide them away from their pad while you dragged
  // one. They are drawn in the floating pass now, right under the pad.
  for (const we of scenery.duckweed) {
    const bob = waterBobAt(we.x, we.y, time) * 0.5;
    const so = shadowOffset(1.9);
    gfx.drawSprite(blob, we.x + so[0], we.y + so[1] + bob * 0.4, 3, 2.4, 0, [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], CONFIG.shadows.floatAlpha * 0.7], false);
  }
  for (const mo of scenery.surfaceMoss) {
    const bob = waterBobAt(mo.x, mo.y, time) * 0.5;
    const so = shadowOffset(2.4);
    gfx.drawSprite(blob, mo.x + so[0], mo.y + so[1] + bob * 0.4, mo.size * 0.9, mo.size * 0.62, mo.rot, [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], CONFIG.shadows.floatAlpha], false);
  }

  // koi, deepest first so the shallow ones pass over the top
  for (const k of koiSorted) {
    const gulpPulse = k.gulpAnim > 0 ? 1 + Math.sin((0.4 - k.gulpAnim) / 0.4 * Math.PI) * 0.06 : 1;
    const a = k.aabb;
    gfx.drawFish({
      canvas: k.canvas, extents: k.extents, spineTex: k.spineTex,
      spineData: k.spineData, spineN: SPINE_NODES,
      spriteW: k.length, spriteH: k.height, vc: k.spineRow / k.height,
      scale: k.depthScale() * gulpPulse,
      x: (a.minX + a.maxX) / 2, y: (a.minY + a.maxY) / 2,
      w: (a.maxX - a.minX) + 8, h: (a.maxY - a.minY) + 8,
      tint: [1, 1, 1, 1 - k.depth * 0.1],
      deepTint: k.depth * 0.32,
    });
  }

  // minnows ride just under the surface
  for (const school of world.minnows) {
    for (const m of school.fish) {
      const a = m.aabb;
      gfx.drawFish({
        canvas: m.canvas, extents: m.extents, spineTex: m.spineTex,
        spineData: m.spineData, spineN: MINNOW_NODES,
        spriteW: m.canvas.width, spriteH: m.canvas.height,
        vc: m.sprite.spineRow / m.canvas.height,
        scale: 1,
        x: (a.minX + a.maxX) / 2, y: (a.minY + a.maxY) / 2,
        w: (a.maxX - a.minX) + 6, h: (a.maxY - a.minY) + 6,
        tint: [1, 1, 1, 0.96],
        deepTint: 0.18,
      });
    }
  }

  // weed beds on the floor, drawn under the surface so they tint and bend.
  // Anything sitting on the floor still throws a short shadow where it meets
  // it, otherwise it reads as floating.
  const propSo = shadowOffset(1.3);
  for (const w of scenery.weeds) {
    gfx.drawSprite(w.tex, w.x + propSo[0], w.y + propSo[1], w.w, w.h, w.rot,
      [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], CONFIG.shadows.propAlpha], false);
    gfx.drawSprite(w.tex, w.x, w.y, w.w, w.h, w.rot, [0.74, 0.88, 0.84, 0.92], false);
  }
  // mossy stones standing in the shallows (under the surface, so the water
  // pass bends and tints them with everything else)
  for (const s of scenery.shore) {
    if (!s.submerged) continue;
    gfx.drawSprite(s.tex, s.x + propSo[0], s.y + propSo[1], s.w, s.h, s.rot,
      [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], CONFIG.shadows.propAlpha], false);
    gfx.drawSprite(s.tex, s.x, s.y, s.w, s.h, s.rot, [0.86, 0.94, 0.94, 0.95], false);
  }

  // butterfly shadows and their faint reflection on the surface
  // moss mats sit on the surface, a hair proud of the water
  for (const mo of scenery.surfaceMoss) {
    const bob = waterBobAt(mo.x, mo.y, time) * 0.5;
    gfx.drawSprite(mo.tex, mo.x, mo.y + bob, mo.size, mo.size * 0.8, mo.rot, [0.98, 1.04, 0.96, 1], false);
  }
  for (const bf of Pond.butterflies) {
    const bso = shadowOffset(2.6);
    gfx.drawSprite(blob, bf.x + bso[0], bf.y + bso[1], 6, 4, 0, [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], CONFIG.shadows.butterflyAlpha], false);
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
    const bso = shadowOffset(1.7);
    gfx.drawSprite(s.tex, s.x + bso[0], y + bso[1], s.w, s.h, s.rot,
      [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], CONFIG.shadows.bankAlpha], false);
    gfx.drawSprite(s.tex, s.x, y, s.w, s.h, s.rot, [1, 1, 1, 1], false);
  }
  for (const pad of scenery.pads) {
    const bob = padBobAt(pad, time);
    const so = shadowOffset(3.2);
    // one pass, drawn together, so nothing can separate them
    gfx.drawSprite(pad.tex, pad.x + so[0], pad.y + so[1] + bob * 0.5, pad.size * 0.99, pad.size * 0.96, pad.rot,
      [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], CONFIG.shadows.padAlpha], false);
    // hover and grab read as light, never as size: a pad is always exactly
    // pad.size, it just catches more sun when your pointer is on it
    const hovered = Pond.state.hoverPad === pad || Pond.state.selPad === pad;
    const held = Pond.state.dragPad === pad;
    const glow = (hovered ? 0.5 : 0) + (held ? 0.5 : 0);
    const s = pad.shade * (1 + glow * 0.22);
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
  // moss mats sit on the surface, a hair proud of the water
  for (const mo of scenery.surfaceMoss) {
    const bob = waterBobAt(mo.x, mo.y, time) * 0.5;
    gfx.drawSprite(mo.tex, mo.x, mo.y + bob, mo.size, mo.size * 0.8, mo.rot, [0.98, 1.04, 0.96, 1], false);
  }
  for (const bf of Pond.butterflies) {
    gfx.drawSprite(bf.canvas, bf.x, bf.y, bf.canvas.width, bf.canvas.height, bf.rot, [1, 1, 1, 1], false);
  }
  for (const pellet of world.pellets) {
    const bob = waterBobAt(pellet.x, pellet.y, time) * 0.5;
    gfx.drawSprite(Pond.crumbCanvas(), pellet.x, pellet.y + bob, 3, 3, 0, [1, 1, 1, 1], false);
  }
  if (Pond.state.showSpines) gfx.drawSpinesDebug(world);
  probeTick();

  gfx.present(world);
}

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
