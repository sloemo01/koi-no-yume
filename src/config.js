// Every knob lives here. Edit, reload, the pond changes.
"use strict";

const CONFIG = {
  seed: 20261017,

  // backing-store divisor: the scene renders at window / pixelSize and the
  // canvas is stretched back up with image-rendering: pixelated
  pixelSize: 4,

  ponds: {
    // the water fills the whole canvas: the shoreline is pushed outside the
    // frame, so the visible area is all pond with the floor shelving up
    // toward the edges
    overscan: 1.28,
    wobbleA: 0.1,
    wobbleB: 0.045,
  },

  koi: {
    count: 12,
    minCount: 3,
    maxCount: 26,
    length: [30, 46],
    // ten nishikigoi looks; each fish gets its own painted pattern
    palettes: [
      "kohaku", "sanke", "showa", "utsuri", "bekko",
      "tancho", "ogon", "platinum", "asagi", "chagoi",
    ],
    cruiseSpeed: [9, 16], // backing px / second
    turnRate: [3.2, 5.2],
    depthRise: 0.9, // seconds to rise when called
  },

  minnows: {
    schools: 4,
    perSchool: [5, 8],
    length: 10,
    // a bolt reaction shared by the whole school
    cruiseSpeed: 12,
    dartSpeed: 52,
    fleeRadius: 34,
  },

  butterflies: {
    count: 3,
    cruiseSpeed: [8, 14],
    wanderDuration: [2.5, 7],
    visitChance: 0.55,
    orbitDuration: [2.5, 6],
    restDuration: [1.6, 4.5],
    flapSpeed: [7, 11],
    palettes: [
      { wing: "#e08a2e", wingLight: "#f3b95c", accent: "#5b3413", body: "#3a2716" }, // monarch
      { wing: "#f2ead6", wingLight: "#ffffff", accent: "#d9a13c", body: "#4a4136" }, // cabbage white
      { wing: "#7c9fd4", wingLight: "#b9d0ef", accent: "#2c3f66", body: "#2b3040" }, // blue
    ],
  },

  pads: {
    clusters: [3, 5],
    perCluster: [2, 4],
    size: [16, 32],
    flowerChance: 0.42,
    dragLag: 0.34, // 0..1, lower = heavier pad
  },

  moss: { clumps: 16 },
  stones: { count: 7 },
  reeds: { clusters: 5 },
  tufts: { count: 26 },
  shoreFlowers: { clusters: 6 },
  duckweed: { patches: 7, perPatch: [4, 9] },

  // ripple profiles, seconds and backing px. A click is a small cluster of
  // rings that expands once and fades; nothing ever bounces back off the
  // frame, because the ring lives on a timeline instead of a grid.
  ripples: {
    touch: {
      rings: 3, stagger: 0.09, lifetime: 1.6, startRadius: 3,
      expandSpeed: 52, distortion: 4.8, sharpness: 0.26,
      fadeStart: 0.42, decay: 0.30, initialStrength: 1.35,
    },
    mouth: {
      rings: 1, stagger: 0, lifetime: 0.9, startRadius: 1.2,
      expandSpeed: 26, distortion: 4.4, sharpness: 0.6,
      fadeStart: 0.3, decay: 0.3, initialStrength: 0.6,
    },
    wake: {
      rings: 1, stagger: 0, lifetime: 1.0, startRadius: 1, expandSpeed: 22,
      distortion: 2.6, sharpness: 0.65, fadeStart: 0.3, decay: 0.5,
      initialStrength: 0.55,
    },
    splash: {
      rings: 2, stagger: 0.07, lifetime: 1.2, startRadius: 2, expandSpeed: 38,
      distortion: 4.2, sharpness: 0.42, fadeStart: 0.36, decay: 0.4,
      initialStrength: 0.9,
    },
    maxActive: 32,
  },

  // the water surface pass: whole-pixel refraction of everything below
  water: {
    bend: 5.5, // px per unit of slope
    maxBend: 9, // hard clamp, px
    microBend: 1.4, // sub-pixel swell bend
    specular: 0.16,
    deepTint: [0.60, 0.80, 0.84], // multiplied into deep water
    shallowLift: 0.03,
    shallowColor: [0.62, 0.80, 0.74], // the shallows keep a water hue
    shallowMix: 0.28,
  },

  swell: {
    amp: 1.1, // px of vertical travel for floating things
    periods: [11.5, 7.3, 4.9, 3.1],
  },

  clouds: {
    // only their shade is visible, drifting over the water
    count: 2,
    speed: [2.4, 3.6], // px/s
    shade: [0.16, 0.11],
    radius: [170, 240],
  },

  bed: {
    sand: [176, 162, 130],
    mud: [120, 128, 92],
    deep: [26, 60, 58],
    algae: [58, 92, 58],
    pebble: [148, 140, 122],
    bank: [96, 132, 62],
    bankDark: [64, 94, 46],
    mudEdge: [128, 116, 88],
  },

  caustics: { amp: 0.115 },
  sun: {
    dir: [-0.5, -0.78],
    color: [1.0, 0.97, 0.86],
  },
  bloom: { threshold: 0.9, gain: 1.3, strength: 0.42 },
  vignette: 0.24,

  shadows: {
    koiAlpha: [0.14, 0.26], // by depth
    padAlpha: 0.16,
    butterflyAlpha: 0.12,
  },

  sound: { startOn: false, volume: 0.5 },
};
