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
    grab: null,
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
    // glue and a ceiling: the water bed wants to be present, not peaking
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -14;
    this.limiter.knee.value = 10;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.22;
    this.master.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);
  },
  setEnabled(on) {
    this.enabled = on;
    if (on) {
      this.init();
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
      this.loadAssets();
      this.startBed();
    } else {
      this.stopBed();
    }
  },

  // ---- the flowing-water bed ------------------------------------------------
  // Pink-ish noise through a band-pass whose centre and level follow the flow
  // field's kinetic energy, so the pond gets louder and brighter where the
  // water is actually moving. Two layers: a bright wash and a slow lap.

  // ---- recorded water ------------------------------------------------------
  // Files live in assets/audio. Mixkit licence: free, no attribution needed.
  assetUrls: {
    bed: "assets/audio/water-bed.mp3",
    birds: [
      "assets/audio/bird-1.mp3", "assets/audio/bird-2.mp3",
      "assets/audio/bird-3.mp3", "assets/audio/bird-4.mp3",
    ],
  },
  assets: { bed: null, birds: [] },
  assetsLoaded: false,
  assetsLoading: false,

  loadAssets() {
    if (this.assetsLoaded || this.assetsLoading || !this.ctx) return;
    this.assetsLoading = true;
    const decode = (url) => fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(url + " " + r.status);
        return r.arrayBuffer();
      })
      .then((buf) => this.ctx.decodeAudioData(buf));
    Promise.all([
      decode(this.assetUrls.bed),
      Promise.all(this.assetUrls.birds.map(decode)),
    ]).then(([bed, birds]) => {
      this.assets = { bed, birds };
      this.assetsLoaded = true;
      this.assetsLoading = false;
      // the synthesised bed was already running by the time the file decoded;
      // swap it out instead of leaving the stand-in playing forever
      if (this.enabled) {
        if (this.bed && !this.bed.recorded) this.stopBed();
        this.startBed();
      }
    }).catch((e) => {
      this.assetsLoading = false;
      this.assetsError = String(e && e.message ? e.message : e);
      // the synthesised voices stay as the fallback
      if (this.enabled) this.startBed();
    });
  },

  makeNoise(seconds) {
    const sr = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * seconds));
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let slow = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        slow = slow * 0.94 + white * 0.06;      // rolling low end
        data[i] = white * 0.5 + slow * 2.4;
      }
      // fade the seam so the loop does not click
      const fade = Math.min(2048, len >> 2);
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        data[i] *= k;
        data[len - 1 - i] *= k;
      }
    }
    return buf;
  },
  startBed() {
    if (!this.ctx || this.bed) return;
    const ctx = this.ctx;
    if (this.assetsLoaded && this.assets.bed) {
      this.startRecordedBed();
      return;
    }
    const noise = this.noiseBuffer || (this.noiseBuffer = this.makeNoise(6));
    const t = ctx.currentTime;
    const wash = ctx.createBufferSource();
    wash.buffer = noise; wash.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 160;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 520; bp.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    wash.connect(hp); hp.connect(bp); bp.connect(g);
    if (pan) { g.connect(pan); pan.connect(this.master); } else { g.connect(this.master); }
    wash.start(t);
    g.gain.setTargetAtTime(0.05, t, 1.4);

    const lap = ctx.createBufferSource();
    lap.buffer = noise; lap.loop = true; lap.playbackRate.value = 0.71;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 430;
    const g2 = ctx.createGain(); g2.gain.value = 0.0001;
    lap.connect(lp); lp.connect(g2); g2.connect(this.master);
    lap.start(t);
    g2.gain.setTargetAtTime(0.035, t, 1.8);

    this.bed = { wash, lap, bp, lp, g, g2, pan };
  },
  // the real thing: a recorded river, gently filtered and slowly panned
  startRecordedBed() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.assets.bed;
    src.loop = true;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2400;
    tone.Q.value = 0.4;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.connect(tone); tone.connect(g);
    if (pan) { g.connect(pan); pan.connect(this.master); } else { g.connect(this.master); }
    src.start(t);
    g.gain.setTargetAtTime(0.85, t, 1.6);
    this.bed = { wash: src, lap: null, bp: tone, lp: tone, g, g2: null, pan, recorded: true };
  },
  stopBed() {
    if (!this.bed) return;
    const { wash, lap, g, g2 } = this.bed;
    const t = this.ctx.currentTime;
    g.gain.setTargetAtTime(0.0001, t, 0.3);
    if (g2) g2.gain.setTargetAtTime(0.0001, t, 0.3);
    try { wash.stop(t + 1.4); } catch (e) { void e; }
    if (lap) { try { lap.stop(t + 1.4); } catch (e) { void e; } }
    this.bed = null;
  },
  // called from the frame loop; cheap, and throttled by the caller
  setFlow(speed, swell) {
    if (!this.bed || !this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.max(0, Math.min(1, speed / 9));
    if (this.bed.recorded) {
      // barely any movement: this is a calm backdrop, not a river. The field
      // nudges the tone and the level a little and that is all.
      this.bed.bp.frequency.setTargetAtTime(1700 + 900 * s, t, 1.2);
      this.bed.g.gain.setTargetAtTime(0.8 + 0.1 * s + 0.02 * (swell || 0), t, 1.0);
    } else {
      this.bed.bp.frequency.setTargetAtTime(340 + 980 * s, t, 0.35);
      this.bed.g.gain.setTargetAtTime(0.028 + 0.105 * s + 0.012 * (swell || 0), t, 0.3);
      this.bed.lp.frequency.setTargetAtTime(360 + 190 * (swell || 0), t, 0.6);
      if (this.bed.g2) this.bed.g2.gain.setTargetAtTime(0.022 + 0.04 * (swell || 0), t, 0.5);
    }
    if (this.bed.pan) this.bed.pan.pan.setTargetAtTime(Math.sin(t * 0.21) * 0.42, t, 1.6);
  },
  // every event gets its own gain and stereo position, so a splash on the left
  // is heard on the left
  bus(pan) {
    const g = this.ctx.createGain();
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan || 0));
      g.connect(p);
      p.connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  },

  // A water drop, built the way water actually sounds: the film breaks (bright
  // tick), the trapped bubble rings and its resonance climbs as it shrinks, the
  // mass of water thumps, and the splash tail hisses out. A single sine sweep
  // reads as a beep because nothing in it is broadband.
  plop(strength, pan) {
    // Silenced on purpose: the pond is meant to sound like a place, not like an
    // interface. Clicks, pads and gulps make no sound.
    return;
    /* eslint-disable no-unreachable */
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = Math.max(0.25, Math.min(1.8, strength === undefined ? 1 : strength));
    const out = this.bus(pan);

    if (this.assetsLoaded && this.assets.drops.length) {
      const pick = this.assets.drops[Math.floor(Math.random() * this.assets.drops.length)];
      const src = this.ctx.createBufferSource();
      src.buffer = pick;
      // small rate and timing variation so repeats never sound like a sample
      src.playbackRate.value = 0.86 + Math.random() * 0.3;
      const g = this.ctx.createGain();
      g.gain.value = 0.85 * s;
      src.connect(g); g.connect(out);
      src.start(this.ctx.currentTime + Math.random() * 0.01);
      if (this.assets.bubble && Math.random() < 0.22) {
        const b = this.ctx.createBufferSource();
        b.buffer = this.assets.bubble;
        b.playbackRate.value = 1.1 + Math.random() * 0.4;
        const bg = this.ctx.createGain();
        bg.gain.value = 0.22 * s;
        b.connect(bg); bg.connect(out);
        b.start(this.ctx.currentTime + 0.03 + Math.random() * 0.05);
      }
      return;
    }

    const noise = this.noiseBuffer || (this.noiseBuffer = this.makeNoise(6));

    // 1. the tick of the surface film breaking
    const tick = ctx.createBufferSource();
    tick.buffer = noise;
    const tickBp = ctx.createBiquadFilter();
    tickBp.type = "bandpass"; tickBp.frequency.value = 3400; tickBp.Q.value = 0.9;
    const tickG = ctx.createGain();
    tickG.gain.setValueAtTime(0.0001, t);
    tickG.gain.exponentialRampToValueAtTime(0.18 * s, t + 0.004);
    tickG.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    tick.connect(tickBp); tickBp.connect(tickG); tickG.connect(out);
    tick.start(t, Math.random() * 3, 0.07);

    // 2. the bubble: pitch climbs as it shrinks, which is the "water" cue
    const bub = ctx.createOscillator();
    bub.type = "sine";
    const f0 = 250 + Math.random() * 130;
    bub.frequency.setValueAtTime(f0, t);
    bub.frequency.exponentialRampToValueAtTime(f0 * (2.3 + Math.random() * 0.9), t + 0.1);
    const bubG = ctx.createGain();
    bubG.gain.setValueAtTime(0.0001, t);
    bubG.gain.exponentialRampToValueAtTime(0.32 * s, t + 0.008);
    bubG.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    bub.connect(bubG); bubG.connect(out);
    bub.start(t); bub.stop(t + 0.19);

    // 3. the mass of water under it
    const body = ctx.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(210 + Math.random() * 50, t);
    body.frequency.exponentialRampToValueAtTime(92, t + 0.14);
    const bodyG = ctx.createGain();
    bodyG.gain.setValueAtTime(0.0001, t);
    bodyG.gain.exponentialRampToValueAtTime(0.36 * s, t + 0.01);
    bodyG.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    body.connect(bodyG); bodyG.connect(out);
    body.start(t); body.stop(t + 0.28);

    // 4. the splash tail
    const spl = ctx.createBufferSource();
    spl.buffer = noise;
    const splHp = ctx.createBiquadFilter(); splHp.type = "highpass"; splHp.frequency.value = 800;
    const splBp = ctx.createBiquadFilter(); splBp.type = "bandpass"; splBp.frequency.value = 2000; splBp.Q.value = 0.5;
    const splG = ctx.createGain();
    splG.gain.setValueAtTime(0.0001, t);
    splG.gain.exponentialRampToValueAtTime(0.34 * s, t + 0.014);
    splG.gain.exponentialRampToValueAtTime(0.0001, t + 0.22 + 0.12 * s);
    spl.connect(splHp); splHp.connect(splBp); splBp.connect(splG); splG.connect(out);
    spl.start(t, Math.random() * 2.5, 0.4);
  },
  gulp() {
    // a fish surfacing is part of the water bed, not a one-off ping
  },

  // a bird somewhere off frame, now and then. Random gap, random call, random
  // side, so the pattern never settles into a loop.
  birdAt(time) {
    if (!this.enabled || !this.assetsLoaded || !this.assets.birds.length) return;
    const ctx = this.ctx;
    const buf = this.assets.birds[Math.floor(Math.random() * this.assets.birds.length)];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.94 + Math.random() * 0.14;
    const g = ctx.createGain();
    g.gain.value = 0.3 + Math.random() * 0.16;
    const out = this.bus((Math.random() * 2 - 1) * 0.75);
    src.connect(g); g.connect(out);
    src.start(ctx.currentTime + Math.random() * 0.05);
  },

};

// ------------------------------------------------------------------ setup

// a splash on the left of the pond should be heard on the left
function pondPan(x) {
  const w = Pond.world && Pond.world.res ? Pond.world.res.x : 450;
  return Math.max(-0.85, Math.min(0.85, ((x / w) * 2 - 1) * 0.85));
}

function params() {
  const q = new URLSearchParams(window.location.search);
  const out = {};
  if (q.has("seed")) out.seed = parseInt(q.get("seed"), 10) || 1;
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
  // Phones and tablets render a smaller world and stretch it further: a 4 px
  // backing store on a 120 Hz tablet is a lot of fragments for no visible gain.
  const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  // pointer type only: a Windows touch laptop reports ontouchstart but still
  // has a mouse and a keyboard, and should keep the desktop UI
  st.touch = !!coarse;
  if (st.touch) {
    const hint = document.getElementById("hint");
    if (hint) {
      hint.innerHTML =
        '<div class="row"><b>tap</b> the water and the koi come over</div>'
        + '<div class="row dim"><b>drag</b> a lily pad, or drag across the water to push it around</div>';
    }
    // the on-screen keycaps and the scatter shortcut assume a keyboard
    for (const b of document.querySelectorAll(".top-actions .btn kbd")) b.remove();
    const grabBtn = document.getElementById("p-grab");
    if (grabBtn) grabBtn.textContent = "grab";
    const sndBtn = document.getElementById("p-sound");
    if (sndBtn) sndBtn.textContent = "sound";
    for (const b of document.querySelectorAll(".top-actions .btn[data-key='h']")) b.textContent = "hide";
    for (const b of document.querySelectorAll(".top-actions .btn[data-key=' ']")) b.textContent = "scatter";
  }
  if (coarse && !options.pixelSize) st.pixelSize = small ? 3 : 4;
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
  Pond.dragonflies = createDragonflies(new Rand(st.seed ^ 0x1f83d9ab), world.res);
  Pond.striders = createStriders(new Rand(st.seed ^ 0x2545f491), world.res);
  Pond.flow = new FlowField(world.res, 6);
  Pond.flow.build(Pond.scenery);
  world.bubbles = [];

  buildSceneryFor(world);
  wirePanel(); // the panel needs scenery and state; boot is where they exist

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
  installPanelChrome();

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
    minnows: () => world.minnows.map((sc) => ({
      fish: sc.fish.length,
      at: [+sc.x.toFixed(0), +sc.y.toFixed(0)],
      state: sc.state,
    })),
    minnowSprite: () => {
      const sc = world.minnows[0];
      const f = sc && sc.fish[0];
      if (!f) return null;
      const d = f.canvas.getContext("2d").getImageData(0, 0, f.canvas.width, f.canvas.height).data;
      const set = new Set();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      }
      return { w: f.canvas.width, h: f.canvas.height, spineRow: f.sprite.spineRow, distinctColours: set.size };
    },
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
// one pixel scale now: see CONFIG.pixelSize
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


// ------------------------------------------------------------------ bubbles
// Oxygen off the weed beds. A clump releases a thread of bubbles every few
// seconds, they rise with a wobble and pop into a hairline ring at the surface.
// The odd one comes off a fish as well, so the weed beds stop being scenery.
function updateBubbles(dt, time, world, weeds) {
  const B = CONFIG.bubbles;
  const list = world.bubbles || (world.bubbles = []);
  if (weeds) {
    for (const w of weeds) {
      if (w.bubbleTimer === undefined) w.bubbleTimer = time + (w.x % 3) * 1.7;
      if (time < w.bubbleTimer) continue;
      w.bubbleTimer = time + B.weedEvery[0] + Math.random() * (B.weedEvery[1] - B.weedEvery[0]);
      const n = B.perThread[0] + Math.floor(Math.random() * (B.perThread[1] - B.perThread[0] + 1));
      for (let i = 0; i < n; i++) {
        list.push({
          x: w.x + (Math.random() - 0.5) * 5,
          y: w.y + (Math.random() - 0.5) * 4,
          rise: B.rise[0] + Math.random() * (B.rise[1] - B.rise[0]),
          wobble: Math.random() * Math.PI * 2,
          age: 0,
          size: 1 + Math.random() * 1.2,
        });
      }
      if (list.length > 90) list.splice(0, list.length - 90);
    }
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    b.age += dt;
    b.y -= b.rise * dt;
    b.x += Math.sin(time * 3.1 + b.wobble) * 5 * dt;
    if (Pond.flow) {
      const f = Pond.flow.sample(b.x, b.y);
      b.x += f.x * dt * 0.5;
      b.y += f.y * dt * 0.4;
    }
    b.wobble += dt * 2.4;
    if (b.age > 1) {
      // pop: a ring the size of a pinhead
      spawnRipple("mouth", b.x, b.y, { scale: 0.3 });
      list.splice(i, 1);
    }
  }
}

// a fish letting a bubble go, or a puff off a weed clump, on demand
function spawnBubbles(x, y, n, rise) {
  const list = Pond.world && Pond.world.bubbles;
  if (!list) return;
  for (let i = 0; i < n; i++) {
    list.push({
      x: x + (Math.random() - 0.5) * 4,
      y: y + (Math.random() - 0.5) * 3,
      rise: (rise || 10) + Math.random() * 6,
      wobble: Math.random() * Math.PI * 2,
      age: 0,
      size: 1 + Math.random(),
    });
  }
}

function buildSceneryFor(world) {
  const rand = new Rand(Pond.state.seed ^ 0x9e3779b9);
  Pond.scenery = buildScenery(rand, world.res, world.pond);
  // a reseed builds a brand new set of pads, so any reference to the old ones
  // is now a pad that is not drawn anywhere and cannot be pressed
  Pond.state.dragPad = null;
  Pond.state.grab = null;
  Pond.state.hoverPad = null;
  Pond.state.selPad = null;
  // Mark the scenery as built here, not only on the resize path: otherwise the
  // first resize after boot built a second set of pads and the pond reshuffled
  // under a hand that was already holding one.
  Pond.__sceneryBuilt = true;
}

// keep every backing buffer in step with the window
function fit(initial) {
  const canvas = Pond.gfx.canvas;
  const st = Pond.state;
  const cssW = Math.max(120, canvas.clientWidth || window.innerWidth || 800);
  const cssH = Math.max(120, canvas.clientHeight || window.innerHeight || 600);
  let w = Math.round(cssW / st.pixelSize);
  let h = Math.round(cssH / st.pixelSize);
  // clamp both by the same factor: clamping them independently stretched the
  // pond vertically on a landscape phone, where the height hits the floor first
  const lo = 120;
  const hi = 1200;
  const grow = Math.max(lo / w, lo / h);
  if (grow > 1) { w = Math.round(w * grow); h = Math.round(h * grow); }
  const shrink = Math.min(hi / w, hi / h);
  if (shrink < 1) { w = Math.round(w * shrink); h = Math.round(h * shrink); }
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
    wirePanel();
  }
}


// ---- settings panel -------------------------------------------------------
// The pond is yours to shape: koi count, how much greenery floats on it, and
// whether pads grab. The button rows dispatch the same keyboard shortcuts, so
// each action has one code path instead of two.
function panelLabel(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function installPanelChrome() {
  const sheet = document.getElementById("panel");
  const settings = document.getElementById("p-settings");
  const grab = document.getElementById("p-grab");
  if (settings && sheet) {
    settings.addEventListener("click", () => {
      sheet.hidden = !sheet.hidden;
      settings.classList.toggle("on", !sheet.hidden);
      // one panel at a time: on a phone they dock to the same corner
      const adv = document.getElementById("advanced");
      const advBtn = document.getElementById("p-advanced");
      if (!sheet.hidden) $("#hint").addClass("hidden");
      if (!sheet.hidden && adv) {
        adv.hidden = true;
        if (advBtn) advBtn.classList.remove("on");
      }
    });
  }
  const snd = document.getElementById("p-sound");
  if (snd) {
    snd.addEventListener("click", () => {
      Sound.setEnabled(!Sound.enabled);
      snd.classList.toggle("on", Sound.enabled);
      snd.textContent = Sound.enabled
        ? (Pond.state.touch ? "sound" : "Sound on")
        : "Sound";
      if (Sound.enabled) Sound.plop(0.9);
    });
  }
  const advBtn = document.getElementById("p-advanced");
  const advSheet = document.getElementById("advanced");
  if (advBtn && advSheet) {
    advBtn.addEventListener("click", () => {
      advSheet.hidden = !advSheet.hidden;
      advBtn.classList.toggle("on", !advSheet.hidden);
      if (!advSheet.hidden) {
        $("#hint").addClass("hidden");
        refreshAdvanced();
        const basic = document.getElementById("panel");
        const basicBtn = document.getElementById("p-settings");
        if (basic) {
          basic.hidden = true;
          if (basicBtn) basicBtn.classList.remove("on");
        }
      }
    });
  }
  if (grab) {
    grab.addEventListener("click", () => {
      const on = !(Pond.state.grabEnabled !== false);
      Pond.state.grabEnabled = on;
      grab.textContent = on ? "grab: on" : "grab: off";
      grab.classList.toggle("on", !on);
    });
  }
  // clicking off the sheet closes it
  document.addEventListener("pointerdown", (e) => {
    if (!sheet || sheet.hidden) return;
    if (sheet.contains(e.target) || (settings && settings.contains(e.target))) return;
    sheet.hidden = true;
    if (settings) settings.classList.remove("on");
  }, true);
}

function refreshPanel() {
  const st = Pond.state;
  panelLabel("p-koi", String(koiTotal()));
  panelLabel("p-green", String(Pond.greenery || 1));
  const g = document.getElementById("p-grab");
  if (g) {
    g.textContent = Pond.state.touch
      ? (CONFIG.pads.grabbable ? "grab" : "grab off")
      : "grab: " + (CONFIG.pads.grabbable ? "on" : "off");
  }
  refreshAdvanced();
  panelLabel("p-bloom", CONFIG.bloom.strength.toFixed(2));
  panelLabel("p-glow", CONFIG.bloom.glow.toFixed(2));
  panelLabel("p-thresh", CONFIG.bloom.threshold.toFixed(2));
  panelLabel("p-spread", CONFIG.bloom.spread.toFixed(1));
  const l = document.getElementById("p-light");
  if (l) l.textContent = "bloom: " + (CONFIG.bloom.enabled ? "on" : "off");
}

// Greenery is the floating mats: more of them means a greener pond. Rebuilt
// from the original set so every mat keeps a shape the pond already had.
function setGreenery(level) {
  const lv = clamp(Math.round(level * 4) / 4, 0.25, 2.5);
  Pond.greenery = lv;
  const mats = Pond.scenery.surfaceMoss;
  // the baseline is captured whenever it is missing: if the panel was wired
  // before the scenery existed, an empty cache silently made this a no-op
  if (!Pond.__matBase || !Pond.__matBase.length) Pond.__matBase = mats.slice();
  const base = Pond.__matBase;
  if (!base.length) { refreshPanel(); return; }
  const rand = Pond.panelRand || (Pond.panelRand = new Rand(CONFIG.seed ^ 0x51ed));
  const target = Math.round(base.length * lv);
  mats.length = 0;
  for (let i = 0; i < target; i++) {
    const src = base[i % base.length];
    const pt = Pond.world.pond.randomPoint(rand, 0.86, 0.12);
    mats.push({ ...src, x: pt.x, y: pt.y, size: src.size * rand.range(0.8, 1.15) });
  }
  refreshPanel();
}

// ---- advanced settings ----------------------------------------------------
// Everything here mutates CONFIG and then either rebuilds the school or the
// scenery, so the pond you see always matches the numbers on the panel.
function advStep(key, step) {
  const K = CONFIG.koi;
  switch (key) {
    case "size":
      K.sizeScale = clamp((K.sizeScale || 1) + step, 0.5, 2.0);
      rebuildSchool();
      return;
    case "small":
      K.smallCount = Math.round(clamp((K.smallCount || 0) + step, 0, 24));
      K.count = K.maxCount = (K.varieties ? Object.values(K.varieties).reduce((a, b) => a + b, 0) : 24) + K.smallCount;
      rebuildSchool();
      return;
    case "greenery":
      setGreenery((Pond.greenery || 1) + step);
      return;
    case "duckweed":
      setDuckweed((CONFIG.duckweed.level || 1) + step);
      return;
    case "flowers":
      CONFIG.pads.flowerChance = clamp((CONFIG.pads.flowerChance || 0.5) + step, 0, 1);
      buildSceneryFor(Pond.world);
      Pond.__matBase = Pond.scenery.surfaceMoss.slice();
      refreshPanel();
      return;
    default:
      break;
  }
  if (key.indexOf("v:") === 0) {
    const name = key.slice(2);
    const v = CONFIG.koi.varieties || (CONFIG.koi.varieties = {});
    const next = Math.round(clamp((v[name] || 0) + step, 0, 16));
    // at least one koi has to stay in the water
    if (next === 0 && koiTotal() - (v[name] || 0) < 1) return;
    v[name] = next;
    const big = Object.values(v).reduce((a, b) => a + b, 0);
    CONFIG.koi.count = CONFIG.koi.maxCount = big + (CONFIG.koi.smallCount || 0);
    rebuildSchool();
  }
}

function refreshAdvanced() {
  const K = CONFIG.koi;
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  set("a-size", (K.sizeScale || 1).toFixed(2));
  set("a-count", String(koiTotal()));
  const sc = document.getElementById("s-count");
  if (sc && document.activeElement !== sc) sc.value = String(koiTotal());
  set("a-small", String(K.smallCount || 0));
  set("a-green", (Pond.greenery || 1).toFixed(2));
  set("a-duck", (CONFIG.duckweed.level || 1).toFixed(2));
  set("a-flowers", Math.round((CONFIG.pads.flowerChance || 0.5) * 100) + "%");
  const v = K.varieties || {};
  for (const name of Object.keys(v)) set("a-" + name, String(v[name]));
}

// Duckweed level: rebuild the rafts from the original set so the pond keeps the
// shapes it had, just more or fewer of them.
function setDuckweed(level) {
  const lv = clamp(Math.round(level * 4) / 4, 0, 3);
  CONFIG.duckweed.level = lv;
  const base = Pond.__duckBase && Pond.__duckBase.length
    ? Pond.__duckBase
    : (Pond.__duckBase = Pond.scenery.duckweed.slice());
  const list = Pond.scenery.duckweed;
  const target = Math.round(base.length * lv);
  list.length = 0;
  const rand = Pond.panelRand || (Pond.panelRand = new Rand(CONFIG.seed ^ 0x51ed));
  for (let i = 0; i < target; i++) {
    const src = base[i % base.length];
    const pt = Pond.world.pond.randomPoint(rand, 0.86, 0.08);
    list.push({ ...src, x: pt.x, y: pt.y, size: src.size * rand.range(0.9, 1.15) });
  }
  refreshPanel();
}

function wirePanel() {
  if (Pond.__panelWired) return;
  if (!Pond.scenery || !Pond.scenery.surfaceMoss || !Pond.state) return;
  Pond.__panelWired = true;
  Pond.__matBase = Pond.scenery.surfaceMoss.slice();
  $(document).on("input", "#advanced input.slider", function () {
    const key = $(this).attr("data-adv");
    const val = Number(this.value);
    if (key === "count") setKoiTotal(val);
    refreshAdvanced();
  });
  $(document).on("click", "#advanced .abtn", function () {
    const key = $(this).attr("data-adv");
    const step = Number($(this).attr("data-step"));
    advStep(key, step);
    refreshAdvanced();
    setTimeout(() => { refreshAdvanced(); }, 180);
  });
  $(document).on("click", "#panel .sbtn", function () {
    const key = $(this).attr("data-key");
    const gr = $(this).attr("data-greenery");
    const bloomStep = $(this).attr("data-bloom");
    const glowStep = $(this).attr("data-glow");
    const threshStep = $(this).attr("data-thresh");
    const spreadStep = $(this).attr("data-spread");
    if (key !== undefined) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true }));
      setTimeout(refreshPanel, 80);
      return;
    }
    if (bloomStep !== undefined) {
      CONFIG.bloom.strength = clamp(CONFIG.bloom.strength + Number(bloomStep), 0, 2);
      refreshPanel();
      return;
    }
    if (glowStep !== undefined) {
      CONFIG.bloom.glow = clamp(CONFIG.bloom.glow + Number(glowStep), 0, 2);
      refreshPanel();
      return;
    }
    if (threshStep !== undefined) {
      CONFIG.bloom.threshold = clamp(CONFIG.bloom.threshold + Number(threshStep), 0.1, 1.4);
      refreshPanel();
      return;
    }
    if (spreadStep !== undefined) {
      CONFIG.bloom.spread = clamp(CONFIG.bloom.spread + Number(spreadStep), 0.4, 5);
      CONFIG.bloom.glowSpread = CONFIG.bloom.spread * 1.55;
      refreshPanel();
      return;
    }
    if (this.id === "p-light") {
      CONFIG.bloom.enabled = !CONFIG.bloom.enabled;
      refreshPanel();
      return;
    }
    if (gr) {
      setGreenery((Pond.greenery || 1) + (gr === "+" ? 0.25 : -0.25));
      return;
    }
    if (this.id === "p-grab") {
      CONFIG.pads.grabbable = !CONFIG.pads.grabbable;
      if (!CONFIG.pads.grabbable) {
        Pond.state.dragPad = null;
        Pond.state.hoverPad = null;
      }
      Sound.plop(0.9);
    }
    refreshPanel();
  });
  refreshPanel();
}

// ------------------------------------------------------------------ input

// THE one screen-to-world conversion. Everything that needs to know where the
// pointer is comes through here. The canvas is measured on every call, because
// a cached rectangle is only correct until the window is resized, the page is
// zoomed, the canvas moves, or a device pixel ratio changes. A stale rectangle
// is a pad that answers somewhere other than where you are pointing.
function pointerScale(canvas) {
  const rect = canvas.getBoundingClientRect();
  const res = (Pond.world && Pond.world.res) || { x: canvas.width, y: canvas.height };
  Pond.state.kx = rect.width ? res.x / rect.width : 1;
  Pond.state.ky = rect.height ? res.y / rect.height : 1;
  Pond.state.rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  return Pond.state.rect;
}

// Client coordinates to pond coordinates. The canvas rectangle is measured
// here, on every event, and both axes use their own ratio: the renderer maps
// the whole canvas onto the whole backing store, so that is the only ratio
// that describes the drawing. No element offsets are involved, which is what
// makes this the same arithmetic the renderer did, run backwards.
function pointerWorld(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  const res = (Pond.world && Pond.world.res) || { x: canvas.width, y: canvas.height };
  const w = rect.width || canvas.clientWidth || 1;
  const h = rect.height || canvas.clientHeight || 1;
  Pond.state.kx = res.x / w;
  Pond.state.ky = res.y / h;
  Pond.state.rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  return {
    x: (ev.clientX - rect.left) * Pond.state.kx,
    y: (ev.clientY - rect.top) * Pond.state.ky,
  };
}

// same conversion from plain client coordinates, used by the boot check
function pointerPos(canvas, clientX, clientY) {
  return pointerWorld(canvas, { clientX: clientX, clientY: clientY });
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
  const centreHit = findPadAt(pad.x, pad.y);
  // With pixel-exact hit testing the leaf answers where it is painted. The
  // notch is a real hole in the leaf, so a rim probe can land in it: most of
  // the rim must answer, not all of it.
  const centre = centreHit !== null;
  const rim = [0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
    const rad = (a * Math.PI) / 180;
    const hit = findPadAt(pad.x + Math.cos(rad) * half * 0.82, pad.y + Math.sin(rad) * half * 0.82);
    return { angle: a, pass: hit !== null, samePad: hit === pad };
  });
  report.checks.push({ what: "hit test at centre", pass: centre, samePad: centreHit === pad });
  report.checks.push({
    what: "hit test near rim",
    pass: rim.filter((r) => r.pass).length >= 6,
    detail: rim,
  });
  if (!centre || rim.filter((r) => r.pass).length < 6) report.ok = false;

  // Direction check: press the leaf and pull the pointer down. Pond y counts
  // downward, so the pad must move down by the same amount. This is the check
  // that fails loudly if a drag is ever wired the wrong way round.
  let dir = null;
  if (!Pond.state.dragPad) {
    handlePointerDown(pad.x, pad.y);
    const grabbedPad = Pond.state.grab ? Pond.state.grab.pad : null;
    if (grabbedPad) {
      const from = { x: grabbedPad.x, y: grabbedPad.y, homeX: grabbedPad.homeX, homeY: grabbedPad.homeY };
      handlePointerMove(pad.x, pad.y + 12);
      dir = { from: +from.y.toFixed(1), to: +grabbedPad.y.toFixed(1), down: grabbedPad.y > from.y + 6 };
      handlePointerUp();
      grabbedPad.x = from.x;
      grabbedPad.y = from.y;
      grabbedPad.homeX = from.homeX;
      grabbedPad.homeY = from.homeY;
      grabbedPad.driftX = 0;
      grabbedPad.driftY = 0;
    }
  }
  if (dir) {
    report.checks.push({ what: "drag direction", pass: dir.down, detail: dir });
    if (!dir.down) report.ok = false;
  }

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
      const hit = findPadAt(pad.x + dx, pad.y + dy) === pad;
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
  const C = CONFIG.callResponse;
  call.x = x;
  call.y = y;
  call.age = 0;
  call.duration = 10;
  call.active = true;
  // Three concentric rings round the press. One ring cannot hold this many koi:
  // twenty-six fish of fifty pixels need a circumference of about 1400 px, which
  // is wider than the pond. Three rings fit, and each fish gets a fixed slot on
  // one of them, so the shoal settles into rings instead of drifting.
  call.ringBase = 46;
  call.ringStep = 20;
  call.spin = 0.35;
  // The ring's phase carries over between presses. Resetting it to zero put
  // every slot back at its starting angle, so each click sent the whole shoal
  // sideways at once and it never settled into a turning ring.
  call.phase = call.phase || 0;
  // Four rings, not three: at one body length of spacing a 46 px ring holds
  // about six koi, so twenty-six need four rings to sit on.
  const bands = 4;
  const big = [];
  for (let i = 0; i < world.count; i++) {
    const k = world.koi[i];
    if (!k.small) big.push(k);
  }
  const perBand = Math.ceil(big.length / bands);
  call.slotsInBand = [0, 0, 0, 0];
  for (let i = 0; i < big.length; i++) {
    const k = big[i];
    const band = i % bands;
    k.callBand = band;
    k.callSlot = call.slotsInBand[band]++;
    const d = Math.hypot(k.x - x, k.y - y);
    const t = Math.pow(clamp(d / C.distanceAtMaximumDelay, 0, 1), C.distanceExponent);
    // they start up the moment you press, even before their turn to move
    k.inDeep = false;
    k.depthTarget = 0.08;
    k.depthTimer = Math.max(k.depthTimer, 8);
    k.callDelay = C.minimumDelaySeconds + t * C.maximumDistanceDelaySeconds +
      k.rand.range(0, C.randomJitterSeconds) + (1 - k.reactivity) * C.temperamentDelaySeconds;
    // A fish already circling stays circling when you press again: only its
    // ring slot moves. Restarting everyone on every press meant a shoal that
    // was permanently commuting and never settled.
    if (k.responded && d < 150) {
      k.callDelay = 0;
    } else {
      k.responded = false;
      k.callResponseAge = 0;
    }
  }
  // the small orange fish are not koi and do not join
  for (let i = 0; i < world.count; i++) {
    const k = world.koi[i];
    if (!k.small) continue;
    k.callDelay = 1e9;
    k.responded = false;
  }
  void perBand;
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
  Sound.plop(1.0);
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
  Sound.plop(0.9);
}

// Where a pad actually is on screen includes its bob. Drawing and grabbing use
// this same number.
function padBobAt(pad, time) {
  return clamp(waterBobAt(pad.x, pad.y, time) * 0.6, -1.2, 1.2);
}

// The pad's painted pixels, as a 1/0 map. The textures are alpha-hardened to 0
// or 255 when they are painted, so this is the leaf itself and nothing else.
function padAlphaMap(pad) {
  if (pad.alphaMap) return pad.alphaMap;
  const w = pad.tex.width;
  const h = pad.tex.height;
  const data = pad.tex.getContext("2d").getImageData(0, 0, w, h).data;
  const map = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) map[p] = data[i + 3] > 127 ? 1 : 0;
  pad.alphaMap = map;
  return map;
}

// Is this point on the painted leaf? The point is turned back through the same
// rotation the sprite is drawn with, then the pad's own texture alpha answers.
// This is why there is no invisible grab area: a press either lands on green
// paint or it lands on water, exactly as it looks.
function padContainsPoint(pad, x, y, time) {
  const bob = padBobAt(pad, time);
  const dx = x - pad.x;
  const dy = y - (pad.y + bob);
  // inverse of the sprite quad's rotation: lp = R(-rot) * (world - pos)
  const c = Math.cos(pad.rot);
  const s = Math.sin(pad.rot);
  const w = pad.tex.width;
  const h = pad.tex.height;
  // the sprite is drawn at pad.size, so a world-pixel offset scales by w/size
  // into texels. Indexing by the texture's own size keeps the test exact even
  // if a texture is ever painted at a size that differs from the pad's own.
  const sx = (dx * c + dy * s) * (w / pad.size) + w * 0.5;
  const sy = (-dx * s + dy * c) * (h / pad.size) + h * 0.5;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;
  const map = padAlphaMap(pad);
  return map[(sy | 0) * w + (sx | 0)] === 1;
}

function findPadAt(x, y) {
  // one switch, and the whole grab apparatus is off: press, hover, drag and
  // the keyboard nudge all go through here or check this flag
  if (!CONFIG.pads.grabbable) return null;
  const pads = Pond.scenery.pads;
  const time = Pond.world.time;
  // Pads are painted in array order, so a later pad sits over an earlier one.
  // The topmost pad whose paint is under the point is the only one you can
  // actually see there, so that is the one that answers a press and the one
  // that lights up. No radius, no slack, no shadow: the leaf is the target.
  for (let i = pads.length - 1; i >= 0; i--) {
    if (padContainsPoint(pads[i], x, y, time)) return pads[i];
  }
  return null;
}

function handlePointerDown(x, y) {
  const st = Pond.state;
  st.pointer.down = true;
  st.pointer.x = x;
  st.pointer.y = y;
  // A press takes the topmost pad whose disc is under the pointer, and nothing
  // else. The pad keeps the exact offset it had when it was picked up, so it
  // does not jump to the cursor on the first move.
  const pad = findPadAt(x, y);
  if (pad) {
    pad.held = true;
    st.grab = { pad, ox: pad.x - x, oy: pad.y - y };
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
  const grab = st.grab;
  if (grab && grab.pad) {
    const pad = grab.pad;
    // The pad is placed at the pointer plus the offset it was grabbed with.
    // Position, not a running delta: a drag can never drift, and it can never
    // come out reversed, because there is no direction to get wrong. If a
    // move event is missed or arrives twice, the next one still lands the pad
    // exactly where the hand is.
    const wantX = x + grab.ox;
    const wantY = y + grab.oy;
    const margin = pad.size * 0.5 + 1;
    const nx = clamp(wantX, margin, world.res.x - margin);
    const ny = clamp(wantY, margin, world.res.y - margin);
    // The grab offset stays exactly as it was on the press. At the frame edge
    // the leaf holds still while the hand travels, and it picks the hand up
    // again the moment the pointer comes back inside: the same offset is still
    // the right one. Rebasing the offset here made a pad jump by the distance
    // the hand had gone past the edge.
    const moved = Math.hypot(nx - pad.x, ny - pad.y);
    pad.x = nx;
    pad.y = ny;
    pad.driftX = 0;
    pad.driftY = 0;
    probeDragSample(x, y, pad);
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

// the shadow of everything falls away from the sun, at one angle
function shadowOffset(mag) {
  const dir = CONFIG.shadows.dir;
  return [dir[0] * mag, dir[1] * mag];
}

const SHADOW_TINT = CONFIG.shadows.tint;

function handlePointerUp() {
  const st = Pond.state;
  st.pointer.down = false;
  st.grab = null;
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
    // letting go nudges the water once
    spawnRipple("splash", pad.x, pad.y, { scale: 0.9 });
    Sound.plop(0.85);
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
  if (key === "[") return setKoiTotal(koiTotal() - 1);
  if (key === "]") return setKoiTotal(koiTotal() + 1);
// one pixel scale now: see CONFIG.pixelSize
// one pixel scale now: see CONFIG.pixelSize
// one pixel scale now: see CONFIG.pixelSize
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
    Sound.plop(0.55);
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
  // Off by default: this is a debugging surface, and the pointer ring it draws
  // is a second circle on screen that follows the mouse. In normal use it reads
  // as a broken cursor and it is one more thing that can disagree with the
  // pond. Press 'p' or call __pond.probeToggle() to turn it back on.
  on: false,
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
// Debug aid only, and only while the probes are on: a ring at the pointer the
// page itself received. It is not the cursor, and in normal use it reads as a
// second, wrong cursor sitting near the real one, so it stays off unless the
// probes are explicitly switched on.
function markPointer(cssX, cssY) {
  if (!PROBE.on) {
    const stale = document.getElementById("pointer-ring");
    if (stale) stale.remove();
    return;
  }
  let el = document.getElementById("pointer-ring");
  if (!el) {
    el = document.createElement("div");
    el.id = "pointer-ring";
    el.style.cssText = "position:fixed;width:84px;height:84px;margin:-42px 0 0 -42px;border-radius:50%;"
      + "border:2px solid rgba(255,255,255,.85);box-shadow:0 0 0 1px rgba(0,0,0,.35) inset;"
      + "pointer-events:none;z-index:80;mix-blend-mode:difference";
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

function probeDragStart(worldX, worldY, pad) {
  PROBE.drag = {
    t: +Pond.world.time.toFixed(2),
    grabWorld: [+worldX.toFixed(1), +worldY.toFixed(1)],
    padStart: [+pad.x.toFixed(1), +pad.y.toFixed(1)],
    padKindR: pad.r,
    samples: [],
    end: null,
  };
  PROBE.counters.drags = (PROBE.counters.drags || 0) + 1;
}

function probeDragSample(worldX, worldY, pad) {
  const d = PROBE.drag;
  if (!d || d.samples.length > 40) return;
  d.samples.push({
    world: [+worldX.toFixed(1), +worldY.toFixed(1)],
    pad: [+pad.x.toFixed(1), +pad.y.toFixed(1)],
  });
}

function probeDragEnd() {
  const d = PROBE.drag;
  if (!d) return;
  d.end = { t: +Pond.world.time.toFixed(2) };
  if (d.samples.length > 1) {
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    // both sides in pond coordinates: the pad has to travel the same way, by
    // the same distance, as the pointer. No pixel-size or screen-space factor
    // sits between them any more.
    d.pointerDx = +(last.world[0] - first.world[0]).toFixed(1);
    d.pointerDy = +(last.world[1] - first.world[1]).toFixed(1);
    d.padDx = +(last.pad[0] - first.pad[0]).toFixed(1);
    d.padDy = +(last.pad[1] - first.pad[1]).toFixed(1);
    d.followError = +Math.hypot(d.padDx - d.pointerDx, d.padDy - d.pointerDy).toFixed(2);
    d.sameDirection = (Math.abs(d.pointerDx) < 0.5 || Math.sign(d.pointerDx) === Math.sign(d.padDx))
      && (Math.abs(d.pointerDy) < 0.5 || Math.sign(d.pointerDy) === Math.sign(d.padDy));
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
        grabWorld: PROBE.drag.grabWorld, padStart: PROBE.drag.padStart,
        samples: PROBE.drag.samples.length > 10
          ? PROBE.drag.samples.filter((_, i) => i % Math.ceil(PROBE.drag.samples.length / 10) === 0)
          : PROBE.drag.samples,
        pointerDx: PROBE.drag.pointerDx,
        pointerDy: PROBE.drag.pointerDy,
        padDx: PROBE.drag.padDx,
        padDy: PROBE.drag.padDy,
        followError: PROBE.drag.followError,
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
    markPointer(ev.clientX, ev.clientY);
    const p = pointerWorld(canvas, ev);
    if (ev.shiftKey) {
      feed(p.x, p.y);
      probeClick("feed", ev.clientX, ev.clientY, p.x, p.y, {});
      return;
    }
    handlePointerDown(p.x, p.y);
    // the grab toggle in the bar is a real gate, not a label
    if (st.dragPad && Pond.state.grabEnabled === false) {
      st.dragPad = null;
      st.hoverPad = null;
      spawnRipple("mouth", p.x, p.y, { scale: 0.7 });
    }
    if (st.dragPad) {
      // Say so out loud: the pad lifts and the water answers, so a tap or a
      // still hold is not silently ignored.
      spawnRipple("splash", st.dragPad.x, st.dragPad.y, { scale: 0.55 });
      Sound.plop(0.95, pondPan(st.dragPad ? st.dragPad.x : p.x));
      // Capture the pointer: every move and the release come to this canvas
      // even when the hand runs off the edge of the window, so a drag cannot
      // be lost halfway and leave a pad stuck to the cursor.
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { void e; }
    }
    probeTrace("down", ev.clientX, ev.clientY, st.dragPad
      ? { hit: "pad " + padIndexOf(st.dragPad), grabDistance: +Math.hypot(st.dragPad.x - p.x, st.dragPad.y - p.y).toFixed(1) }
      : { hit: "water" });
    probeClick(st.dragPad ? "grab" : "water", ev.clientX, ev.clientY, p.x, p.y,
      st.dragPad ? { grabbed: [+st.dragPad.x.toFixed(1), +st.dragPad.y.toFixed(1)] } : {});
    if (st.dragPad) probeDragStart(p.x, p.y, st.dragPad);
  });
  $(window).on("pointermove", (ev) => {
    // where the real pointer actually is, so a pad can light up under it. With
    // a big cursor-following pet on screen this is the only honest readout of
    // your pointer position.
    // counted before any early return: this is the number that says whether
    // this page is seeing your pointer at all
    PROBE.counters.moves = (PROBE.counters.moves || 0) + 1;
    markPointer(ev.clientX, ev.clientY);
    const hp = pointerWorld(canvas, ev);
    st.pointer.x = hp.x;
    st.pointer.y = hp.y;
    // the pad under the pointer is the pad that would answer a press, and it
    // is the only pad that lights: what glows is exactly what you can grab
    st.hoverPad = st.dragPad || findPadAt(hp.x, hp.y);
    // and if the button came up somewhere this page could not see, let go
    if (st.dragPad && ev.buttons === 0) {
      padDivergenceCheck(st.dragPad);
      probeDragEnd();
      handlePointerUp();
      return;
    }
    if (!st.pointer.down && !st.dragPad) return;
    if (st.dragPad) {
      probeTrace("move (held)", ev.clientX, ev.clientY, { pad: padIndexOf(st.dragPad), padModelAt: [+st.dragPad.x.toFixed(1), +st.dragPad.y.toFixed(1)] });
    }
    handlePointerMove(hp.x, hp.y);
  });
  // only a real pointerup ends a drag; a cancel keeps the pad in hand until
  // the pointer comes back, because a mouse drag can cancel for many reasons
  $(window).on("pointerup", (ev) => {
    const last = PROBE.clicks[PROBE.clicks.length - 1];
    if (last && ev && ev.clientX !== undefined && !last.up) {
      const up = pointerWorld(document.getElementById("pond"), ev);
      last.up = [+up.x.toFixed(1), +up.y.toFixed(1)];
    }
    probeTrace("up", ev && ev.clientX !== undefined ? ev.clientX : -1, ev && ev.clientY !== undefined ? ev.clientY : -1, { pad: st.dragPad ? padIndexOf(st.dragPad) : null });
    if (st.dragPad) padDivergenceCheck(st.dragPad);
    probeDragEnd();
    handlePointerUp();
    if (ev && ev.pointerId !== undefined) {
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { void e; }
    }
    // a finger that lifts is gone: no hover state is left behind on a pad it
    // was never really resting on
    if (ev && ev.pointerType === "touch") {
      st.hoverPad = null;
    }
  });

  // the pointer left the page: nothing is under it any more
  $(canvas).on("pointerleave", () => {
    if (Pond.state.dragPad) return;
    Pond.state.hoverPad = null;
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
// one pixel scale now: see CONFIG.pixelSize
  });
  $("#btn-koi").on("click", () => setKoiCount(st.koiCount + 2));
  $("#btn-koi-less").on("click", () => setKoiCount(st.koiCount - 2));

  // the hint line steps out of the way after a while. Only the hint: the
  // settings panel is a control surface, and hiding it took the pad grab
  // switch away from anyone who was still using the pond.
  window.setTimeout(() => {
    if (!st.hidden) $("#hint, #controls").addClass("hidden");
  }, 32000);
}

function setSound(on) {
  const st = Pond.state;
  st.sound = on;
  Sound.setEnabled(on);
  $("#btn-sound").text(on ? "sound: on" : "sound: off").toggleClass("on", on);
  if (on) Sound.plop(0.9);
}

// The settings panel's Koi number is the sum of the advanced panel's variety
// counts. Growing adds to the variety that is currently scarcest, shrinking takes
// from the most common one, so the two panels can never disagree.
function koiTotal() {
  const v = CONFIG.koi.varieties || {};
  return Object.values(v).reduce((a, b) => a + b, 0);
}

function setKoiTotal(n) {
  const v = CONFIG.koi.varieties || (CONFIG.koi.varieties = {});
  const names = Object.keys(v);
  let want = clamp(Math.round(n), 1, 16 * names.length);
  let total = koiTotal();
  while (total < want) {
    let low = names[0];
    for (const name of names) if (v[name] < v[low]) low = name;
    v[low] += 1;
    total += 1;
  }
  while (total > want) {
    let high = names[0];
    for (const name of names) if (v[name] > v[high]) high = name;
    if (v[high] <= 0) break;
    v[high] -= 1;
    total -= 1;
  }
  CONFIG.koi.count = CONFIG.koi.maxCount = koiTotal() + (CONFIG.koi.smallCount || 0);
  rebuildSchool();
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

// Rebuild every fish from the current config. The advanced panel calls this
// after any change that alters how many fish there are or how big they are.
function rebuildSchool() {
  // coalesce: a run of clicks rebuilds once, a beat later, so holding the button
  // cannot churn hundreds of sprites and textures
  if (Pond.__rebuildQueued) return;
  Pond.__rebuildQueued = setTimeout(() => {
    Pond.__rebuildQueued = null;
    rebuildSchoolNow();
  }, 120);
}

function rebuildSchoolNow() {
  const world = Pond.world;
  for (const k of world.koi) {
    Pond.gfx.freeTexture(k.canvas);
    if (k.spineTex) Pond.gfx.gl.deleteTexture(k.spineTex);
  }
  for (const school of world.minnows) for (const m of school.fish) {
    Pond.gfx.freeTexture(m.canvas);
    if (m.spineTex) Pond.gfx.gl.deleteTexture(m.spineTex);
  }
  const school = createSchool(new Rand((CONFIG.seed ^ 0x51ed) >>> 0), world.pond, world.res);
  Pond.school = school;
  world.koi = school.koi;
  world.minnows = school.minnows;
  world.count = school.koi.length;
  Pond.state.koiCount = world.count;
  for (const k of world.koi) k.spineTex = Pond.gfx.makeSpineTex();
  for (const s2 of world.minnows) for (const m of s2.fish) m.spineTex = Pond.gfx.makeSpineTex();
  world.call.active = false;
  refreshPanel();
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
  for (const b of Pond.dragonflies) {
    for (const f of b.frames) Pond.gfx.freeTexture(f);
  }
  Pond.dragonflies = createDragonflies(new Rand(st.seed ^ 0x1f83d9ab), world.res);
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
    // stones stand in the water, so the fish need to know about them
    stones: Pond.scenery ? Pond.scenery.steppingStones : null,
  };
  // the water bed follows the flow field, so the pond sounds like it is moving
  if (Sound.enabled && Pond.flow) {
    Pond.__soundAt = (Pond.__soundAt || 0) + dt;
    if (Pond.__soundAt > 0.1) {
      Pond.__soundAt = 0;
      const swell = 0.5 + 0.5 * Math.sin(time * 0.6 + 1.2);
      Sound.setFlow(Pond.flow.energy(), swell);
    }
  }
  // birds, off frame, now and then
  if (Sound.enabled && Sound.assetsLoaded) {
    if (Pond.__birdIn === undefined) Pond.__birdIn = 5 + Math.random() * 7;
    Pond.__birdIn -= dt;
    if (Pond.__birdIn <= 0) {
      Sound.birdAt(time);
      Pond.__birdIn = 11 + Math.random() * 20;
    }
  }
  world.call.age = world.call.active ? world.call.age + dt : 999;
  if (world.call.active) {
    world.call.phase = (world.call.phase || 0) + (world.call.spin || 0.35) * dt;
  }
  if (world.call.active && world.call.age > world.call.duration) world.call.active = false;

  for (let i = 0; i < world.count; i++) world.koi[i].update(dt, simWorld);
  for (const school of world.minnows) school.update(dt, simWorld);
  updatePads(dt, time, Pond.scenery.pads, world.pond);
  updateDuckweed(dt, time, Pond.scenery.duckweed, world.pond);
  updateDuckweed(dt, time, Pond.scenery.surfaceMoss, world.pond, 0.5);
  if (Pond.scenery.hyacinths) updateDuckweed(dt, time, Pond.scenery.hyacinths, world.pond, 1.5);
  updateButterflies(dt, time, Pond.butterflies, { pond: world.pond, res: world.res, flowers: Pond.scenery.padFlowers });
  updateDragonflies(dt, time, Pond.dragonflies, world.res);
  updateStriders(dt, time, Pond.striders, {
    res: world.res, koi: world.koi, count: world.count, rings: WATER_FIELD.rings,
  });
  updateBubbles(dt, time, world, Pond.scenery.weeds);
  // the field itself, then everything floating rides it
  if (Pond.flow) Pond.flow.step(dt, { koi: world.koi, count: world.count });

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
      deepTint: k.depth * 0.62,
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
        deepTint: 0.34,
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
  // A dragonfly's shadow is thrown well away from it, and the higher it flies
  // the further out and wider the shadow goes, which is the only height cue a
  // top-down pond has.
  for (const df of Pond.dragonflies) {
    const gap = df.shadowGap();
    const dso = shadowOffset(gap * 0.45);
    const wide = 6.5 + df.z * 4.5;
    gfx.drawSprite(blob, df.x + dso[0], df.y + gap + dso[1], wide, wide * 0.55, 0,
      [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], CONFIG.shadows.butterflyAlpha * 0.85], false);
  }

  // bubbles rising through the water, and the roots of the hyacinths
  for (const b of (world.bubbles || [])) {
    const fade = 1 - Math.max(0, b.age - 0.8) / 0.2;
    gfx.drawSprite(blob, b.x, b.y, b.size * 1.6, b.size * 1.6, 0, [0.82, 0.95, 1, 0.55 * fade], false);
  }
  if (scenery.hyacinths) {
    for (const hy of scenery.hyacinths) {
      const sway = Math.sin(time * 1.4 + hy.x * 0.1) * 1.2;
      for (let i = -1; i <= 1; i++) {
        for (let k = 1; k <= 4; k++) {
          const y = hy.y + 4 + k * 2.4;
          gfx.drawSprite(blob, hy.x + i * 2.2 + sway * (k / 4), y, 1.2, 2.6, 0, [0.72, 0.85, 0.62, 0.5], false);
        }
      }
    }
  }
  // the clay pot, under the surface so the water bends and tints it
  if (scenery.pot) {
    const pso = shadowOffset(1.6);
    gfx.drawSprite(scenery.pot.tex, scenery.pot.x + pso[0], scenery.pot.y + pso[1], scenery.pot.w, scenery.pot.h, scenery.pot.rot,
      [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], CONFIG.shadows.propAlpha], false);
    gfx.drawSprite(scenery.pot.tex, scenery.pot.x, scenery.pot.y, scenery.pot.w, scenery.pot.h, scenery.pot.rot, [0.92, 0.96, 0.94, 1], false);
  }
  // striders: four leg dimples each, no body shadow
  for (const sd of Pond.striders) {
    for (const [dx, dy] of [[-2.2, -2], [2.2, -2], [-2.2, 2], [2.2, 2]]) {
      gfx.drawSprite(blob, sd.x + dx, sd.y + dy + 1.2, 2.4, 1.8, 0,
        [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], CONFIG.shadows.floatAlpha * 0.9], false);
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

  // tobi-ishi: flat stones standing proud of the shallows. Drawn before the
  // pads so a drifting leaf passes over one rather than under it.
  const stoneSo = shadowOffset(2.0);
  for (const ss of scenery.steppingStones) {
    gfx.drawSprite(ss.tex, ss.x + stoneSo[0], ss.y + stoneSo[1], ss.w, ss.h, ss.rot,
      [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], CONFIG.shadows.bankAlpha], false);
    gfx.drawSprite(ss.tex, ss.x, ss.y, ss.w, ss.h, ss.rot, [1, 1, 1, 1], false);
  }

  for (const pad of scenery.pads) {
    const bob = padBobAt(pad, time);
    const so = shadowOffset(3.2);
    // one pass, drawn together, so nothing can separate them
    gfx.drawSprite(pad.tex, pad.x + so[0], pad.y + so[1] + bob * 0.5, pad.size * 0.99, pad.size * 0.96, pad.rot,
      [SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2], CONFIG.shadows.padAlpha], false);
    // A pad answers the pointer with light: the pad's own pixels are added
    // over the top of it, so it brightens in place. A tint bump alone moved
    // the green channel by about one part in twenty, which is nothing on a
    // four-pixel canvas. Only the pad a press would take lights up, so the
    // glow is the grab area and not a guess.
    const hovered = Pond.state.hoverPad === pad || Pond.state.selPad === pad;
    const held = Pond.state.dragPad === pad;
    const lit = held ? 1 : hovered ? 0.85 : 0;
    const s = pad.shade * (1 + lit * 0.12);
    gfx.drawSprite(pad.tex, pad.x, pad.y + bob, pad.size, pad.size, pad.rot, [s, s, s, 1], false);
    if (lit > 0) {
      gfx.drawGlow(pad.tex, pad.x, pad.y + bob, pad.size, pad.size, pad.rot, [1.02, 1.08, 0.88], lit * 0.5);
    }
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
  // water hyacinth: sits a hair higher than a pad and drifts faster
  if (scenery.hyacinths) {
    for (const hy of scenery.hyacinths) {
      const bob = waterBobAt(hy.x, hy.y, time) * 0.7;
      gfx.drawSprite(hy.tex, hy.x, hy.y + bob, hy.size, hy.size * 0.82, hy.rot, [1, 1, 1, 1], false);
    }
  }
  for (const sd of Pond.striders) {
    gfx.drawSprite(sd.canvas, sd.x, sd.y, sd.canvas.width, sd.canvas.height, sd.rot, [1, 1, 1, 1], false);
  }
  // moss mats sit on the surface, a hair proud of the water
  for (const mo of scenery.surfaceMoss) {
    const bob = waterBobAt(mo.x, mo.y, time) * 0.5;
    gfx.drawSprite(mo.tex, mo.x, mo.y + bob, mo.size, mo.size * 0.8, mo.rot, [0.98, 1.04, 0.96, 1], false);
  }
  for (const bf of Pond.butterflies) {
    gfx.drawSprite(bf.canvas, bf.x, bf.y, bf.canvas.width, bf.canvas.height, bf.rot, [1, 1, 1, 1], false);
  }
  for (const df of Pond.dragonflies) {
    // a hair of scale with height, so the ones riding high read as closer
    const k = 1 + df.z * 0.08 + (df.hover || 0) * 0.02;
    gfx.drawSprite(df.canvas, df.x, df.y, df.canvas.width * k, df.canvas.height * k, df.rot, [1, 1, 1, 1], false);
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
