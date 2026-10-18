// Moods. A mood is a small set of numbers the composite pass and the simulation
// read: a two-stop sky gradient (top colour, bottom colour, and how hard it
// bites), how much mist hangs over the water, how heavy the cloud shade is, and
// whether it is raining. Nothing here draws an overlay sprite, so a mood cannot
// look pasted on top of the scene.
"use strict";

function hexToUnit(hex) {
  const h = String(hex || "#ffffff").replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const MOODS = {
  sunny: {
    label: "Sunny",
    skyTop: "#ffffff", skyBot: "#ffffff", skyAmt: 0.00, mist: 0.00,
    glint: 0.10,
    bloom: 1.00,
    glintCol: "#ffd9a8",
    desat: 0.00,
    exposure: 1.00, contrast: 1.04,
    cloud: 0.42, rain: 0, warm: [1.00, 0.995, 0.972], vignette: 0.10, sunPower: 1.0,
  },
  clear: {
    label: "Deep clear",
    skyTop: "#bfe2ff", skyBot: "#e8f6ff", skyAmt: 0.22, mist: 0.00,
    glint: 0.14,
    bloom: 1.10,
    glintCol: "#fff2d8",
    desat: 0.00,
    exposure: 1.02, contrast: 1.06,
    cloud: 0.08, rain: 0, warm: [0.98, 1.00, 1.03], vignette: 0.08, sunPower: 1.05,
  },
  mist: {
    label: "Mist",
    // Misty, not milky: enough haze to read, without flattening the picture.
    // Contrast stays at 1 so the pads and koi keep their edges.
    skyTop: "#dfe9e5", skyBot: "#eef4f1", skyAmt: 0.34, mist: 0.42,
    glint: 0.11,
    bloom: 0.70,
    glintCol: "#ffffff",
    desat: 0.07,
    exposure: 0.99, contrast: 1.02,
    cloud: 0.22, rain: 0, warm: [0.96, 0.99, 0.99], vignette: 0.10, sunPower: 0.8,
  },
  sunset: {
    label: "Sunset",
    skyTop: "#ffb066", skyBot: "#9a8bb8", skyAmt: 0.92, mist: 0.08,
    glint: 1.30,
    bloom: 1.25,
    glintCol: "#ff9c38",
    desat: 0.06,
    exposure: 0.97, contrast: 1.16,
    cloud: 0.28, rain: 0, warm: [1.17, 0.93, 0.79], vignette: 0.16, sunPower: 1.15,
  },
  moonlit: {
    // Built like sunset: a strong two-stop veil that carries the light from one
    // edge to the other. Sunset uses orange over violet, this is moon white over
    // deep blue, and a little brighter so the pond still reads at night.
    label: "Moonlight",
    skyTop: "#e2ecff", skyBot: "#5a6a94", skyAmt: 0.86, mist: 0.10,
    glint: 1.15, bloom: 1.40,
    glintCol: "#cfe0ff",
    desat: 0.28,
    exposure: 0.86, contrast: 1.12,
    cloud: 0.26, rain: 0, warm: [0.92, 0.98, 1.12], vignette: 0.17,
    sunPower: 0.95, moon: 0.18, moonCol: "#d5e3ff",
  },
  rain: {
    label: "Rain",
    // Wet water still catches light, so the glints stay, but at a fraction of a
    // sunny day. The clouds are the heavy part: deeper shade, more of it, and a
    // little softness so it reads as cloud shadow and not as painted blobs.
    skyTop: "#7d8a97", skyBot: "#54626f", skyAmt: 0.38, mist: 0.12,
    glint: 0.30,
    bloom: 0.90,
    glintCol: "#ffffff",
    desat: 0.16,
    exposure: 0.93, contrast: 1.03,
    cloud: 0.58, rain: 1, warm: [0.93, 0.97, 1.02], vignette: 0.15,
    sunPower: 0.92, cloudSoft: 0.35,
  },
};

const MOOD_ORDER = ["sunny", "clear", "mist", "sunset", "moonlit", "rain"];

function currentMood() {
  return CONFIG.mood || MOODS.sunny;
}

// the shader wants unit colours, the panels want hex
function moodAsConfig(m) {
  return Object.assign({}, m, {
    top: hexToUnit(m.skyTop),
    bottom: hexToUnit(m.skyBot),
  });
}

function setMood(name) {
  const m = MOODS[name] || MOODS.sunny;
  CONFIG.mood = moodAsConfig(Object.assign({}, m, { name }));
  // the shade and vignette already existed as their own knobs; a mood sets them
  // so one control moves the whole picture, and the sliders can still override
  CONFIG.clouds.shade = m.cloud;
  CONFIG.vignette = m.vignette;
  for (const el of document.querySelectorAll("#advanced .chip[data-mood]")) {
    el.classList.toggle("on", el.getAttribute("data-mood") === name);
  }
  if (typeof Pond !== "undefined") Pond.moodName = name;
  // keep the bar label in step no matter who changed the mood: a probe, a
  // keyboard shortcut or the panel all end up here, and the button used to keep
  // the old name until the menu was opened again
  if (typeof Pond !== "undefined" && Pond.paintMood) Pond.paintMood();
  if (typeof refreshPanel === "function") refreshPanel();
}

// live edits from the colour pickers
function setSkyColour(which, hex) {
  if (!CONFIG.mood) setMood("sunny");
  if (which === "top") {
    CONFIG.mood.skyTop = hex;
    CONFIG.mood.top = hexToUnit(hex);
  } else {
    CONFIG.mood.skyBot = hex;
    CONFIG.mood.bottom = hexToUnit(hex);
  }
}

function setSkyAmount(v) {
  if (!CONFIG.mood) setMood("sunny");
  CONFIG.mood.skyAmt = Math.max(0, Math.min(1, v));
}
