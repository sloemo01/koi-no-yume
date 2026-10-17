// Small math toolbox: seeded randomness, value noise, angle helpers.
// Everything random in the pond flows through Rand so a seed always
// rebuilds the exact same pond.
"use strict";

const TAU = Math.PI * 2;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// frame-rate independent easing toward a target
function approach(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function smoothstep(lo, hi, v) {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

function wrapAngle(a) {
  let r = a;
  while (r > Math.PI) r -= TAU;
  while (r < -Math.PI) r += TAU;
  return r;
}

// turn heading toward a target heading by at most `maxStep`
function angleToward(from, to, maxStep) {
  const d = wrapAngle(to - from);
  if (Math.abs(d) <= maxStep) return to;
  return wrapAngle(from + Math.sign(d) * maxStep);
}

// mulberry32 — small, fast, seedable
function Rand(seed) {
  this.state = (seed >>> 0) || 0x9e3779b9;
}

Rand.prototype.unit = function () {
  this.state = (this.state + 0x6d2b79f5) >>> 0;
  let t = this.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

Rand.prototype.range = function (lo, hi) {
  return lo + (hi - lo) * this.unit();
};

Rand.prototype.int = function (lo, hi) {
  return Math.floor(this.range(lo, hi + 1));
};

Rand.prototype.chance = function (p) {
  return this.unit() < p;
};

Rand.prototype.angle = function () {
  return this.unit() * TAU;
};

Rand.prototype.pick = function (arr) {
  return arr[Math.floor(this.unit() * arr.length) % arr.length];
};

Rand.prototype.sign = function () {
  return this.unit() < 0.5 ? -1 : 1;
};

// --- value noise (scalar, 2D), deterministic, no tables to load ---

function hash2(x, y) {
  let h = Math.imul(x | 0, 0x27d4eb2f) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function fbm2(x, y, octaves) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

// --- colors ---

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb) {
  const c = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return "#" + c(rgb[0]) + c(rgb[1]) + c(rgb[2]);
}

function mixRgb(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// shade by a factor: >1 lighter, <1 darker
function shadeRgb(rgb, k) {
  return [clamp(rgb[0] * k, 0, 255), clamp(rgb[1] * k, 0, 255), clamp(rgb[2] * k, 0, 255)];
}

// how many steps a path with `segments` covers; used by trail sampling
function sampleSegments(x0, y0, x1, y1, spacing, out, maxSteps) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const steps = clamp(Math.floor(len / spacing), 1, maxSteps || 32);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    out.push({ x: x0 + dx * t, y: y0 + dy * t });
  }
  return len;
}
