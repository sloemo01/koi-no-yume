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
    count: 32,        // total in the pond: big nishikigoi plus the small ones
    minCount: 3,
    maxCount: 32,
    smallCount: 8,    // a few small orange fish, not a shoal of them
    smallLength: 0.56,
    sizeScale: 1.0,   // every koi's length, as a multiple
    length: [30, 46],
    // ten nishikigoi looks; each fish gets its own painted pattern
    palettes: [
      "kohaku", "sanke", "showa", "utsuri", "bekko",
      "tancho", "ogon", "platinum", "asagi", "chagoi", "shiro",
    ],
    // the pond is stocked by variety instead of by weight: four of each, so the
    // six kinds are always all present and always in the same numbers
    varieties: {
      kohaku: 4, sanke: 4, showa: 4, ogon: 4, tancho: 4, shiro: 4,
    },
    cruiseSpeed: [9, 16], // backing px / second
    turnRate: [3.2, 5.2],
    depthRise: 0.9, // seconds to rise when called
  },

  minnows: {
    schools: 4,
    perSchool: [5, 8],
    length: 12,
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
    // pads are grabbable: press a painted leaf pixel and it follows your hand
    grabbable: true,
    clusters: [3, 4],
    perCluster: [3, 4],
    size: [24, 48],
    flowerChance: 0.5,
    dragLag: 0.34, // 0..1, lower = heavier pad
  },
  weeds: { clumps: 14 },
  surfaceMoss: { clumps: 28, size: [8, 16] },

  moss: { clumps: 48 },
  stones: { count: 12 },
  reeds: { clusters: 5 },
  tufts: { count: 26 },
  shoreFlowers: { clusters: 6 },
  // duckweed grows in rafts: patches of ten to twenty motes, tightly grouped
  duckweed: { patches: 28, perPatch: [12, 22], spread: [20, 14], level: 1 },

  // callResponse values mirrored from the nagomi pond: delay grows with
  // distance, the chase is a short sprint, then they settle round the point
  callResponse: {
    minimumDelaySeconds: 0.04,
    distanceAtMaximumDelay: 360,
    maximumDistanceDelaySeconds: 1.05,
    distanceExponent: 1.5,
    randomJitterSeconds: 0.18,
    temperamentDelaySeconds: 0.22,
    targetLifetimeSeconds: 6.2,
    chaseBoostSeconds: 2.6,
    chaseSpeedMultiplier: 2.3,
    initialExtraSpeedMultiplier: 0.34,
  },

  // water hyacinth: floating rosettes, roots below the surface
  hyacinths: { count: 4 },

  // water striders: they stand on the surface film
  striders: { count: 6 },

  // oxygen bubbles: threads off the weed beds, and the odd one from a fish
  bubbles: { weedEvery: [2.2, 6.5], perThread: [3, 6], rise: [9, 16], fishChance: 0.35 },

  // tobi-ishi: loose chains plus loners, sizes and angles all random. The
  // spread is wider than the stones themselves, so the water between two of
  // them is a channel a fish can take instead of a wall.
  stepping: { runs: 4, runLength: [2, 4], loners: 7, spread: [44, 62], size: [0.85, 1.4] },

  dragonflies: {
    count: 5,
    palettes: ["emerald", "blue", "red", "bronze"],
    hoverSpeed: [5, 11],
    dartSpeed: [58, 96],
    wingRate: [24, 34],
    hoverTime: [1.1, 3.4],
    dartTime: [0.28, 0.6],
    lowSkim: 0.35,   // how often a hover is spent low over the water
  },

  // ripple profiles, seconds and backing px. A click is a small cluster of
  // rings that expands once and fades; nothing ever bounces back off the
  // frame, because the ring lives on a timeline instead of a grid.
  ripples: {
    touch: {
      // a leading crest with two weaker followers, and the crest slows as it
      // travels (radius goes with sqrt of time) the way a real ring does
      rings: 3, stagger: 0.16, lifetime: 1.9, startRadius: 2,
      expandSpeed: 34, distortion: 5.2, sharpness: 0.42,
      fadeStart: 0.46, decay: 0.28, initialStrength: 1.1, falloff: 0.32,
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
    maxActive: 44,
  },

  // the water surface pass: whole-pixel refraction of everything below
  water: {
    bend: 5.5, // px per unit of slope
    maxBend: 9, // hard clamp, px
    microBend: 1.4, // sub-pixel swell bend
    specular: 0.16,
    deepTint: [0.46, 0.60, 0.66], // multiplied into deep water
    shallowLift: 0.03,
    shallowColor: [0.58, 0.78, 0.86], // the shallows keep a water hue
    shallowMix: 0.28,
  },

  swell: {
    amp: 1.1, // px of vertical travel for floating things
    periods: [11.5, 7.3, 4.9, 3.1],
  },

  clouds: {
    // No cloud is drawn anywhere. Only its shadow reaches the water, as one
    // drifting noise field cut into two flat tones with hard edges, so it
    // reads as pixel art and not as a soft photographic stain.
    shade: 0.42,     // how far the core of a mass dims the pond
    scale: 0.0042,   // world px to field units: lower is bigger masses
    drift: 1.0,      // how fast the field travels
  },

  bed: {
    // the floor is blue: pale pebbles, blue-grey silt, navy in the deep, and
    // only the weed stays green so the plants still read as plants. Lifted a
    // step overall, so the water reads sunlit rather than dusk
    pebble: [198, 216, 238],
    sand: [160, 188, 218],
    mud: [128, 160, 200],
    deep: [74, 106, 154],
    algae: [88, 132, 146],
    bank: [110, 146, 176],
    bankDark: [78, 110, 140],
    mudEdge: [146, 168, 196],
  },

  caustics: { amp: 0.115 },
  sun: {
    // y counts down from the top of the pond, so a sun in the upper left is
    // negative in both axes, and shadows fall down and to the right.
    dir: [-0.5, -0.78],
    color: [1.0, 0.97, 0.86],
  },
  bloom: {
    // Two scales of light: a tight bloom on the highlights and a wide glow that
    // carries it outward. Every value here is live, so the panel can move it.
    enabled: true,
    threshold: 0.66,  // where a pixel starts to glow
    knee: 0.22,       // softness of that edge, keeps highlights from popping
    gain: 1.15,       // how much light the bright pass collects
    spread: 1.7,      // blur radius of the tight bloom
    glowSpread: 2.6,  // extra radius of the wide glow
    strength: 1.1,     // tight bloom
    glow: 0.6,         // wide glow
  },
  vignette: 0.24,

  shadows: {
    // one light direction for everything, away from the sun: down and to the
    // right, which is +y in a world that counts y downward from the top.
    dir: [0.54, 0.84],
    tint: [0.05, 0.10, 0.17], // blue, so shadows sit on the blue floor
    koiAlpha: [0.12, 0.22], // by depth
    padAlpha: 0.15,
    floatAlpha: 0.2,
    propAlpha: 0.18,
    bankAlpha: 0.2,
    butterflyAlpha: 0.12,
  },

  sound: { startOn: false, volume: 0.9 },
};
