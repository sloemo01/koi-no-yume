// The water surface, such as it is: a calm analytic swell plus a handful of
// rings. Every ring is a jQuery job — a plain object animated from p=0 to
// p=1 by jQuery's own ticker, and the step callback is what turns that
// timeline into a radius and an amplitude for the shader. Nothing is a grid
// simulation, so a ring can never bounce off the frame and come back: it
// simply expands once and fades.
"use strict";

const WATER_FIELD = { rings: [], jobs: 0, spawned: 0 };

const RING_KINDS = ["touch", "mouth", "wake", "splash"];

function waterProfile(kind) {
  return CONFIG.ripples[kind] || CONFIG.ripples.touch;
}

// the shared ring math: both this JS mirror and the shader use it
function ringBand(dist, radius, sharpness) {
  return Math.exp(-Math.abs(dist - radius) * sharpness);
}

// fade over the timeline: full strength until fadeStart, then out
function ringFade(p, profile) {
  const fade = 1 - smoothstep(profile.fadeStart, 1, p);
  return Math.max(0, fade) * (1 - p * profile.decay);
}

function spawnRipple(kind, x, y, opts) {
  // a splash is a real shove, not just a drawn ring
  if (typeof Pond !== "undefined" && Pond.flow && (kind === "splash" || kind === "grab")) {
    const k = opts && opts.scale ? opts.scale : 1;
    Pond.flow.impulse(x, y, 1.6 * k, 18 + 10 * k);
  }
  if (WATER_FIELD.suppress) return null;
  const profile = waterProfile(kind);
  const rings = (opts && opts.rings) || profile.rings;
  const probe = window.__probes ? window.__probes.noteRipple(kind, x, y, rings) : null;
  const scale = (opts && opts.scale) || 1;
  for (let i = 0; i < rings; i++) {
    if (WATER_FIELD.rings.length >= CONFIG.ripples.maxActive) {
      // Fish and pads fill the ring budget with wake rings, and recycling the
      // oldest used to take click ripples with it, so a click could be gone
      // before it had finished expanding. Evict wakes first; a touch or a
      // splash is only taken if there is nothing else left.
      const wakeOnly = WATER_FIELD.rings.filter((r) => r.kind !== "touch" && r.kind !== "splash");
      const source = wakeOnly.length ? wakeOnly : WATER_FIELD.rings;
      const oldest = source.reduce((a, b) => (a.p > b.p ? a : b));
      releaseRing(oldest);
      const idx = WATER_FIELD.rings.indexOf(oldest);
      if (idx >= 0) WATER_FIELD.rings.splice(idx, 1);
    }
    const ring = {
      kind,
      x, y,
      p: 0,
      delay: i * profile.stagger,
      startRadius: profile.startRadius * scale,
      expand: profile.expandSpeed * scale * profile.lifetime,
      // the leading crest is the strongest, the rest die away
      strength: profile.initialStrength * scale * ((opts && opts.sign) || 1)
        * Math.pow(1 - (profile.falloff || 0), i),
      sharpness: profile.sharpness,
      profile,
      alive: true,
      jq: null,
      radius: 0,
      amp: 0,
      age: 0,
    };
    ring.radius = ring.startRadius;
    ring.amp = 0;
    ring.spawnRec = probe;
    WATER_FIELD.rings.push(ring);
    WATER_FIELD.spawned++;
    armRing(ring);
  }
  return WATER_FIELD.rings[WATER_FIELD.rings.length - 1];
}

// the jQuery part: one animation job per ring drives p from 0 to 1
function armRing(ring) {
  const duration = Math.max(80, ring.profile.lifetime * 1000);
  const start = () => {
    if (ring.armed || !ring.alive) return;
    ring.armed = true;
    WATER_FIELD.jobs++;
    ring.jq = $(ring).animate({ p: 1 }, {
      duration,
      easing: "linear",
      step: () => {
        const p = clamp(ring.p, 0, 1);
        ring.age = p * ring.profile.lifetime;
        // sqrt: a ring runs out of speed as it grows, like water does
        ring.radius = ring.startRadius + ring.expand * Math.sqrt(p);
        ring.amp = ring.strength * ringFade(p, ring.profile);
      },
      complete: () => {
        ring.alive = false;
        releaseRing(ring);
      },
    });
  };
  if (ring.delay > 0) {
    window.setTimeout(start, ring.delay * 1000);
  } else {
    start();
  }
  ring.startJob = start;
}

function releaseRing(ring) {
  ring.alive = false;
  if (ring.jq) {
    if (typeof ring.jq.stop === "function") ring.jq.stop(true, false);
    ring.jq = null;
  }
  if (ring.armed) {
    ring.armed = false;
    WATER_FIELD.jobs = Math.max(0, WATER_FIELD.jobs - 1);
  }
}

function updateWaterField(dt) {
  // rings carry their own state via the jQuery jobs; drop the dead ones
  for (let i = WATER_FIELD.rings.length - 1; i >= 0; i--) {
    if (!WATER_FIELD.rings[i].alive) WATER_FIELD.rings.splice(i, 1);
  }
}

function resetWaterField() {
  for (const ring of WATER_FIELD.rings) releaseRing(ring);
  WATER_FIELD.rings.length = 0;
  WATER_FIELD.spawned = 0;
}

// ---- analytic queries, used by floating things and by tests ----

// the ambient swell: four slow crossing waves, in pixels of travel. Must
// match swellH() in the shaders so bobbing and refraction agree.
function swellAt(x, y, time) {
  const s = CONFIG.swell;
  return (
    Math.sin((x * 0.031 + y * 0.021) + time * (TAU / s.periods[0])) * 0.5 +
    Math.sin((y * 0.047 - x * 0.017) + time * (TAU / s.periods[1]) + 1.7) * 0.32 +
    Math.sin((x * 0.083 + y * 0.06) + time * (TAU / s.periods[2]) + 4.1) * 0.18 +
    Math.sin((x * 0.19 - y * 0.13) + time * (TAU / s.periods[3]) + 0.9) * 0.3
  ) * s.amp;
}

// vertical bob for something floating at x,y (backing px)
function waterBobAt(x, y, time) {
  let h = swellAt(x, y, time);
  for (const ring of WATER_FIELD.rings) {
    if (!ring.alive || ring.age <= 0) continue;
    const dist = Math.hypot(x - ring.x, y - ring.y);
    if (dist > ring.radius + 40) continue;
    h += ringBand(dist, ring.radius, ring.sharpness) * ring.amp * 0.55;
  }
  return h;
}

// how the rings would push a floating leaf around: away from each crest
function waterPushAt(x, y, dt) {
  let px = 0;
  let py = 0;
  for (const ring of WATER_FIELD.rings) {
    if (!ring.alive || ring.age <= 0) continue;
    const dx = x - ring.x;
    const dy = y - ring.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (dist > ring.radius + 24 || dist < 0.5) continue;
    const band = ringBand(dist, ring.radius, ring.sharpness) * ring.amp;
    px += (dx / dist) * band * 2.2 * dt;
    py += (dy / dist) * band * 2.2 * dt;
  }
  return { x: px, y: py };
}

// is this point inside the pond (used by floating things deciding to ride water)
function waterHeightSampleCount() {
  return WATER_FIELD.rings.length;
}
