// Raw WebGL 2, no libraries. The scene renders into a small buffer
// (window / pixelSize) and is stretched back up with image-rendering:
// pixelated, so every frame is genuinely pixel art.
//
// pass order: pond bed and everything under the surface -> water surface
// (whole-pixel refraction of what is below) -> floating things and the bank
// -> bloom -> composite with cloud shade and vignette.
"use strict";

const MAX_RINGS = 32;
const MAX_SPINE = 16;

const GLSL_COMMON = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uRim[64];
uniform vec4 uPond;
uniform vec4 uRings[${MAX_RINGS}];
uniform float uRingK[${MAX_RINGS}];
uniform int uRingCount;
uniform float uSwellAmp;
uniform vec3 uSun;
uniform float uSunPower;

float rimFactorAt(float angle) {
  float f = (angle / 6.28318530718 + 0.5) * 64.0;
  float fr = f - floor(f);
  int i0 = int(floor(f));
  int a = ((i0 % 64) + 64) % 64;
  int b = (a + 1) % 64;
  return mix(uRim[a], uRim[b], fr);
}

float pondD(vec2 p) {
  vec2 q = (p - uPond.xy) / uPond.zw;
  return length(q) / max(rimFactorAt(atan(q.y, q.x)), 0.001);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  local = local * local * (3.0 - 2.0 * local);
  float a = hash12(cell);
  float b = hash12(cell + vec2(1.0, 0.0));
  float c = hash12(cell + vec2(0.0, 1.0));
  float d = hash12(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, local.x), mix(c, d, local.x), local.y);
}

vec3 shadeRgb3(vec3 c, float k) {
  return clamp(c * k, 0.0, 1.0);
}

// displacement of every live ring, in pixels. The same maths lives in
// water.js so the CPU can bob floating things with it.
// unsigned strength of the ripple crests at p: 0 away from every ring,
// rising to the amplitude on a crest. This is what the light catches.
float ringCrest(vec2 p, float offsetPx) {
  float acc = 0.0;
  for (int i = 0; i < ${MAX_RINGS}; i++) {
    if (i >= uRingCount) break;
    vec4 r = uRings[i];
    float dist = max(length(p - r.xy), 0.0001);
    float sd = dist - r.z - offsetPx;
    // 2.8x the ring's own falloff: the crest has to read as a line you can
    // see, not as a broad lift on the whole neighbourhood
    acc += exp(-abs(sd) * uRingK[i] * 2.8) * r.w;
  }
  return acc;
}

vec2 ringDisp(vec2 p) {
  vec2 acc = vec2(0.0);
  for (int i = 0; i < ${MAX_RINGS}; i++) {
    if (i >= uRingCount) break;
    vec4 r = uRings[i];
    vec2 rel = p - r.xy;
    float dist = max(length(rel), 0.0001);
    float sd = dist - r.z;
    float band = exp(-abs(sd) * uRingK[i]) * r.w;
    acc += (rel / dist) * sign(sd) * band;
  }
  return acc;
}

// the ambient swell: three slow crossing waves plus one finer ripple, and
// their analytic slope. swellH must match swellAt() in water.js.
// cell site hash for the caustic mosaic
vec2 causticHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

float swellWarp(vec2 p) {
  return (vnoise(p * 0.0125) - 0.5) * 6.2 + (vnoise(p * 0.043 + 11.0) - 0.5) * 1.8;
}

float swellH(vec2 p) {
  float w = swellWarp(p);
  return (
    sin((p.x * 0.031 + p.y * 0.021) + w * 0.8 + uTime * 0.5464) * 0.5 +
    sin((p.y * 0.047 - p.x * 0.017) + w * 0.7 + uTime * 0.8607 + 1.7) * 0.32 +
    sin((p.x * 0.083 + p.y * 0.060) + w * 0.5 + uTime * 1.2823 + 4.1) * 0.16 +
    sin((p.x * 0.190 - p.y * 0.130) + w * 0.35 + uTime * 2.0268 + 0.9) * 0.14
  ) * uSwellAmp;
}

// The curvature of the same swell the surface waves are made of. A dip in
// the surface is a converging lens, so this is what focuses sunlight into
// caustics on the floor.
float swellLap(vec2 p) {
  float w = swellWarp(p);
  return (
    // the long swell sets the big cells and how they wander
    -0.0014 * sin((p.x * 0.031 + p.y * 0.021) + w * 0.8 + uTime * 0.5464) * 1.5 +
    -0.0025 * sin((p.y * 0.047 - p.x * 0.017) + w * 0.7 + uTime * 0.8607 + 1.7) * 0.96 +
    -0.0105 * sin((p.x * 0.083 + p.y * 0.060) + w * 0.5 + uTime * 1.2823 + 4.1) * 0.48 +
    // capillary ripples. Curvature goes with the square of the wavenumber,
    // so these tiny fast waves are what etch the fine bright filaments of a
    // caustic net while the swell moves the net around.
    -0.26 * sin((p.x * 0.55 + p.y * 0.38) + uTime * 3.4) * 0.42 +
    -0.28 * sin((p.y * 0.61 - p.x * 0.30) + uTime * 2.7 + 2.3) * 0.38 +
    -0.40 * sin((p.x * 0.74 - p.y * 0.52) + uTime * 4.1 + 5.1) * 0.30
  ) * uSwellAmp;
}

vec2 swellGrad(vec2 p) {
  float d0 = cos((p.x * 0.031 + p.y * 0.021) + uTime * 0.5464) * 0.5;
  float d1 = cos((p.y * 0.047 - p.x * 0.017) + uTime * 0.8607 + 1.7) * 0.32;
  float d2 = cos((p.x * 0.083 + p.y * 0.060) + uTime * 1.2823 + 4.1) * 0.18;
  float d3 = cos((p.x * 0.190 - p.y * 0.130) + uTime * 2.0268 + 0.9) * 0.30;
  return vec2(
    d0 * 0.031 - d1 * 0.017 + d2 * 0.083 + d3 * 0.190,
    d0 * 0.021 + d1 * 0.047 + d2 * 0.060 - d3 * 0.130
  ) * uSwellAmp;
}
`;

function Gfx(canvas) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (!gl) throw new Error("WebGL2 is not available in this browser");

  this.gl = gl;
  this.canvas = canvas;
  this.targets = {};
  this.textureCache = new Map();
  this.extCache = new Map();
  this.pixelStorei = gl.pixelStorei.bind(gl);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

  // ---- fullscreen quad ----
  this.quadVao = gl.createVertexArray();
  gl.bindVertexArray(this.quadVao);
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // ---- sprite quad ----
  this.spriteVao = gl.createVertexArray();
  gl.bindVertexArray(this.spriteVao);
  const spriteBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -0.5, -0.5, 0.5, -0.5, 0.5, 0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
  ]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);

  this.programs = {
    bed: this.makeProgram(BED_VS, BED_FS),
    water: this.makeProgram(FLAT_VS, WATER_FS),
    sprite: this.makeProgram(SPRITE_VS, SPRITE_FS),
    fish: this.makeProgram(SPRITE_VS, FISH_FS),
    bright: this.makeProgram(FLAT_VS, BRIGHT_FS),
    blur: this.makeProgram(FLAT_VS, BLUR_FS),
    composite: this.makeProgram(FLAT_VS, COMPOSITE_FS),
  };

  this.blendPremultiplied = false;
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);
}

Gfx.prototype.makeProgram = function (vsSrc, fsSrc) {
  const gl = this.gl;
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vsSrc);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    throw new Error("vertex shader: " + gl.getShaderInfoLog(vs));
  }
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fsSrc);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    throw new Error("fragment shader: " + gl.getShaderInfoLog(fs));
  }
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("link: " + gl.getProgramInfoLog(p));
  }
  const uniforms = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, "");
    uniforms[name] = gl.getUniformLocation(p, info.name);
  }
  return { program: p, u: uniforms };
};

Gfx.prototype.resize = function (w, h) {
  const gl = this.gl;
  w = Math.max(2, Math.floor(w));
  h = Math.max(2, Math.floor(h));
  this.width = w;
  this.height = h;
  this.canvas.width = w;
  this.canvas.height = h;
  const make = (ww, hh) => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ww, hh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w: ww, h: hh };
  };
  for (const key of Object.keys(this.targets)) {
    const t = this.targets[key];
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }
  const bw = Math.max(2, Math.floor(w / 2));
  const bh = Math.max(2, Math.floor(h / 2));
  const gw = Math.max(2, Math.floor(w / 4));
  const gh = Math.max(2, Math.floor(h / 4));
  this.targets = {
    under: make(w, h),
    scene: make(w, h),
    bloomA: make(bw, bh),
    bloomB: make(bw, bh),
    // the wide half of the light: a quarter-res copy, blurred again, which
    // gives the soft halo around bright things that a single blur cannot
    glowA: make(gw, gh),
    glowB: make(gw, gh),
  };
};

Gfx.prototype.bindTarget = function (target) {
  const gl = this.gl;
  if (target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
  }
};

Gfx.prototype.clear = function (r, g, b) {
  const gl = this.gl;
  gl.clearColor(r, g, b, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
};

// upload a canvas as a NEAREST texture, once
Gfx.prototype.tex = function (canvasEl) {
  if (this.textureCache.has(canvasEl)) return this.textureCache.get(canvasEl);
  const gl = this.gl;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvasEl);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  this.textureCache.set(canvasEl, tex);
  return tex;
};

Gfx.prototype.freeTexture = function (canvasEl) {
  if (this.textureCache.has(canvasEl)) {
    this.gl.deleteTexture(this.textureCache.get(canvasEl));
    this.textureCache.delete(canvasEl);
  }
  if (this.extCache.has(canvasEl)) {
    this.gl.deleteTexture(this.extCache.get(canvasEl));
    this.extCache.delete(canvasEl);
  }
};

Gfx.prototype.setCommon = function (prog, world) {
  const gl = this.gl;
  const u = prog.u;
  gl.uniform2f(u.uRes, world.res.x, world.res.y);
  gl.uniform1f(u.uTime, world.time);
  gl.uniform1fv(u.uRim, world.rimTable);
  gl.uniform4f(u.uPond, world.pond.cx, world.pond.cy, world.pond.rx, world.pond.ry);
  const rings = WATER_FIELD.rings;
  const packed = new Float32Array(MAX_RINGS * 4);
  const packedK = new Float32Array(MAX_RINGS);
  // The shader only has room for MAX_RINGS rings, and wake rings from fish and
  // pads fill that buffer on their own. Uploading the array in creation order
  // meant a fresh click ring waited at the back of the queue until older rings
  // died, which is exactly the lag you feel on a click. Rank by what the ring is
  // for, then by how strong it is.
  const rank = (r) => {
    const kindWeight = r.kind === "touch" ? 5000
      : r.kind === "splash" ? 4000
      : r.kind === "rain" ? 3000
      : r.kind === "mouth" ? 2000 : 1000;
    return kindWeight + Math.abs(r.amp) * 100;
  };
  const live = [];
  for (const ring of rings) {
    if (!ring.alive || Math.abs(ring.amp) <= 0.001) continue;
    live.push({ r: ring, w: rank(ring) });
  }
  live.sort((a, b) => b.w - a.w);
  const n = Math.min(live.length, MAX_RINGS);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const ring = live[i].r;
    packed[count * 4] = ring.x;
    packed[count * 4 + 1] = ring.y;
    packed[count * 4 + 2] = ring.radius;
    packed[count * 4 + 3] = ring.amp;
    packedK[count] = ring.sharpness;
    count++;
  }
  gl.uniform4fv(u.uRings, packed);
  gl.uniform1fv(u.uRingK, packedK);
  gl.uniform1i(u.uRingCount, count);
  gl.uniform1f(u.uSwellAmp, CONFIG.swell.amp);
  gl.uniform3f(u.uSun, CONFIG.sun.color[0], CONFIG.sun.color[1], CONFIG.sun.color[2]);
  world.ringUniformCount = count;
};

Gfx.prototype.drawBed = function (world) {
  const gl = this.gl;
  const prog = this.programs.bed;
  gl.useProgram(prog.program);
  this.setCommon(prog, world);
  const u = prog.u;
  const bed = CONFIG.bed;
  gl.uniform3f(u.uSand, ...bed.sand.map((v) => v / 255));
  gl.uniform3f(u.uMud, ...bed.mud.map((v) => v / 255));
  gl.uniform3f(u.uDeep, ...bed.deep.map((v) => v / 255));
  gl.uniform3f(u.uAlgae, ...bed.algae.map((v) => v / 255));
  gl.uniform3f(u.uPebble, ...bed.pebble.map((v) => v / 255));
  // a mood can soften the caustics: an overcast sky throws no hard light, so the
  // dappling on the floor has to go diffuse with it
  const causticAmp = (CONFIG.mood && typeof CONFIG.mood.caustics === "number")
    ? CONFIG.caustics.amp * CONFIG.mood.caustics
    : CONFIG.caustics.amp;
  gl.uniform1f(u.uCaustics, causticAmp);
  gl.bindVertexArray(this.quadVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
};

Gfx.prototype.drawWater = function (world) {
  const gl = this.gl;
  const prog = this.programs.water;
  gl.useProgram(prog.program);
  this.setCommon(prog, world);
  const u = prog.u;
  const w = CONFIG.water;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this.targets.under.tex);
  gl.uniform1i(u.uUnder, 0);
  gl.uniform1f(u.uBend, w.bend);
  gl.uniform1f(u.uMaxBend, w.maxBend);
  gl.uniform1f(u.uSpecular, w.specular);
  // How much direct sun the water is allowed to throw back. Overcast has no sun
  // disc at all, so the glint and the sparkle have to go, or the pond reads as
  // sunny with a grey filter on it.
  gl.uniform1f(u.uSunPower, (CONFIG.mood && typeof CONFIG.mood.sunPower === "number") ? CONFIG.mood.sunPower : 1);
  gl.uniform1f(u.uShallowLift, w.shallowLift);
  gl.uniform1f(u.uShallowMix, w.shallowMix);
  gl.uniform3f(u.uShallowColor, w.shallowColor[0], w.shallowColor[1], w.shallowColor[2]);
  gl.uniform3f(u.uDeepTint, w.deepTint[0], w.deepTint[1], w.deepTint[2]);
  gl.uniform2f(u.uLight, CONFIG.sun.dir[0], CONFIG.sun.dir[1]);
  gl.bindVertexArray(this.quadVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
};

Gfx.prototype.drawSprite = function (canvasEl, x, y, w, h, rot, tint, flipV) {
  const gl = this.gl;
  const prog = this.programs.sprite;
  gl.useProgram(prog.program);
  const u = prog.u;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this.tex(canvasEl));
  gl.uniform1i(u.uTex, 0);
  gl.uniform2f(u.uRes, this.width, this.height);
  gl.uniform2f(u.uPos, x, y);
  gl.uniform2f(u.uSize, w, h);
  gl.uniform1f(u.uRot, rot || 0);
  gl.uniform4fv(u.uTint, tint || [1, 1, 1, 1]);
  gl.uniform1f(u.uFlipV, flipV ? 1 : 0);
  gl.bindVertexArray(this.spriteVao);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
};

// Additive pass: the same silhouette added on top of itself. A hovered pad
// brightens by its own colour instead of being scaled up, so a pad that says
// "press me" is still exactly the size of the pad you are aiming at. The
// blend mode only exists for the length of this draw, so every other sprite
// keeps normal alpha blending.
Gfx.prototype.drawGlow = function (canvasEl, x, y, w, h, rot, color, strength) {
  const gl = this.gl;
  const s = strength === undefined ? 0.4 : strength;
  if (s <= 0) return;
  const prog = this.programs.sprite;
  gl.useProgram(prog.program);
  const u = prog.u;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this.tex(canvasEl));
  gl.uniform1i(u.uTex, 0);
  gl.uniform2f(u.uRes, this.width, this.height);
  gl.uniform2f(u.uPos, x, y);
  gl.uniform2f(u.uSize, w, h);
  gl.uniform1f(u.uRot, rot || 0);
  const c = color || [1, 1, 0.9];
  gl.uniform4f(u.uTint, c[0] * s, c[1] * s, c[2] * s, 1);
  gl.uniform1f(u.uFlipV, 0);
  gl.bindVertexArray(this.spriteVao);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
};

Gfx.prototype.makeSpineTex = function () {
  const gl = this.gl;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, MAX_SPINE, 1, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
};

// the painted silhouette, one texel per sprite column, uploaded once
Gfx.prototype.extentsTex = function (canvasEl, extents) {
  if (this.extCache.has(canvasEl)) return this.extCache.get(canvasEl);
  const gl = this.gl;
  const cols = Math.max(1, Math.round(extents.length / 2));
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, cols, 1, 0, gl.RG, gl.FLOAT, extents);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  this.extCache.set(canvasEl, tex);
  return tex;
};

Gfx.prototype.drawFish = function (opts) {
  const gl = this.gl;
  const prog = this.programs.fish;
  gl.useProgram(prog.program);
  const u = prog.u;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this.tex(opts.canvas));
  gl.uniform1i(u.uSprite, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, this.extentsTex(opts.canvas, opts.extents));
  gl.uniform1i(u.uExt, 1);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, opts.spineTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, opts.spineN, 1, gl.RGBA, gl.FLOAT, opts.spineData);
  gl.uniform1i(u.uSpine, 2);
  gl.uniform1i(u.uSpineN, opts.spineN);
  gl.uniform1f(u.uSpriteW, opts.spriteW);
  gl.uniform1f(u.uSpriteH, opts.spriteH);
  gl.uniform1f(u.uScale, opts.scale || 1);
  gl.uniform1f(u.uVC, opts.vc);
  gl.uniform2f(u.uOffset, (opts.offset && opts.offset[0]) || 0, (opts.offset && opts.offset[1]) || 0);
  gl.uniform4fv(u.uTint, opts.tint || [1, 1, 1, 1]);
  gl.uniform1f(u.uDeepTint, opts.deepTint || 0);
  gl.uniform3f(u.uDeepColor, CONFIG.water.deepTint[0], CONFIG.water.deepTint[1], CONFIG.water.deepTint[2]);
  gl.uniform1fv(u.uRim, this.rimTable || new Float32Array(64).fill(1));
  gl.uniform4f(u.uPond, this.pondCx || 0, this.pondCy || 0, this.pondRx || 1, this.pondRy || 1);
  gl.uniform2f(u.uRes, this.width, this.height);
  gl.uniform2f(u.uPos, opts.x, opts.y);
  gl.uniform2f(u.uSize, opts.w, opts.h);
  gl.uniform1f(u.uRot, 0);
  gl.uniform1f(u.uFlipV, 0);
  gl.bindVertexArray(this.spriteVao);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
};

// the fish shader clips against the pond and needs its shoreline table
Gfx.prototype.setPondFrame = function (world) {
  this.rimTable = world.rimTable;
  this.pondCx = world.pond.cx;
  this.pondCy = world.pond.cy;
  this.pondRx = world.pond.rx;
  this.pondRy = world.pond.ry;
};

Gfx.prototype.drawSpinesDebug = function (world) {
  // simple 1px lines: reuse the sprite program with tiny quads
  const gl = this.gl;
  const prog = this.programs.sprite;
  gl.useProgram(prog.program);
  const u = prog.u;
  gl.uniform1i(u.uTex, 0);
  gl.uniform2f(u.uRes, this.width, this.height);
  gl.uniform4f(u.uTint, 1, 0.35, 0.3, 0.9);
  gl.uniform1f(u.uFlipV, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this.tex(WORLD_DEBUG_DOT()));
  gl.bindVertexArray(this.spriteVao);
  for (const k of world.koi.slice(0, world.count)) {
    for (const node of k.spine) {
      gl.uniform2f(u.uPos, node.x, node.y);
      gl.uniform2f(u.uSize, 1.4, 1.4);
      gl.uniform1f(u.uRot, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }
};

Gfx.prototype.present = function (world) {
  const gl = this.gl;
  const bw = this.targets.bloomA;
  const gw = this.targets.glowA;
  const bloom = CONFIG.bloom;

  // bright pass, half res
  let prog = this.programs.bright;
  gl.useProgram(prog.program);
  gl.bindVertexArray(this.quadVao);
  gl.bindFramebuffer(gl.FRAMEBUFFER, bw.fbo);
  gl.viewport(0, 0, bw.w, bw.h);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this.targets.scene.tex);
  gl.uniform1i(prog.u.uScene, 0);
  gl.uniform2f(prog.u.uTexel, 1 / this.width, 1 / this.height);
  gl.uniform1f(prog.u.uThreshold, bloom.enabled ? bloom.threshold : 2.0);
  gl.uniform1f(prog.u.uGain, bloom.gain);
  gl.uniform1f(prog.u.uKnee, bloom.knee);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // tight bloom: blur across into B, then down back into A
  const blur = this.programs.blur;
  gl.useProgram(blur.program);
  const pass = (src, dst, dir, spread) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(blur.u.uTex, 0);
    gl.uniform2f(blur.u.uTexel, 1 / dst.w, 1 / dst.h);
    gl.uniform2f(blur.u.uDir, dir[0], dir[1]);
    gl.uniform1f(blur.u.uSpread, spread);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  pass(bw, this.targets.bloomB, [1, 0], bloom.spread);
  pass(this.targets.bloomB, bw, [0, 1], bloom.spread);

  // wide glow: the tight result, quarter res, blurred again with a bigger
  // radius. Two scales of light is what makes a bloom read as glow instead of
  // a haze that lifts the whole frame.
  pass(bw, gw, [1, 0], bloom.spread * 0.5);
  pass(gw, this.targets.glowB, [0, 1], bloom.glowSpread);
  pass(this.targets.glowB, gw, [1, 0], bloom.glowSpread);

  // composite to the canvas
  prog = this.programs.composite;
  gl.useProgram(prog.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, this.width, this.height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this.targets.scene.tex);
  gl.uniform1i(prog.u.uScene, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, bw.tex);
  gl.uniform1i(prog.u.uBloom, 1);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, gw.tex);
  gl.uniform1i(prog.u.uGlow, 2);
  gl.uniform2f(prog.u.uRes, this.width, this.height);
  gl.uniform1f(prog.u.uTime, world.time);
  const mood = (typeof currentMood === "function" ? currentMood() : null) || {
    warm: [1, 0.995, 0.972], sky: [1, 1, 1], skyAmt: 0, mist: 0,
  };

  gl.uniform1f(prog.u.uStrength, bloom.enabled ? bloom.strength * (mood.bloom || 1) : 0);
  gl.uniform1f(prog.u.uGlowStrength, bloom.enabled ? bloom.glow * (mood.bloom || 1) : 0);
  gl.uniform1f(prog.u.uVignette, CONFIG.vignette);
  gl.uniform1f(prog.u.uCloudShade, CONFIG.clouds.shade);
  gl.uniform1f(prog.u.uCloudScale, CONFIG.clouds.scale);
  gl.uniform1f(prog.u.uCloudDrift, CONFIG.clouds.drift);
  gl.uniform3f(prog.u.uWarm, mood.warm[0], mood.warm[1], mood.warm[2]);
  const top = mood.top || [1, 1, 1];
  const bot = mood.bottom || top;
  gl.uniform3f(prog.u.uSkyTop, top[0], top[1], top[2]);
  gl.uniform3f(prog.u.uSkyBot, bot[0], bot[1], bot[2]);
  gl.uniform1f(prog.u.uMoodAmt, mood.skyAmt || 0);
  gl.uniform1f(prog.u.uMist, mood.mist || 0);
  gl.uniform1f(prog.u.uSkyLift, mood.skyLift || 0);
  gl.uniform1f(prog.u.uCloudSoft, mood.cloudSoft || 0);
  gl.uniform1f(prog.u.uMoon, mood.moon || 0);
  const mc = typeof hexToUnit === "function" ? hexToUnit(mood.moonCol || "#c3d6ff") : [0.76, 0.84, 1.0];
  gl.uniform3f(prog.u.uMoonCol, mc[0], mc[1], mc[2]);
  gl.uniform1f(prog.u.uGlint, mood.glint || 0);
  const gc = typeof hexToUnit === "function" ? hexToUnit(mood.glintCol || "#ffffff") : [1, 1, 1];
  gl.uniform3f(prog.u.uGlintCol, gc[0], gc[1], gc[2]);
  gl.uniform1f(prog.u.uDesat, mood.desat || 0);
  gl.uniform1f(prog.u.uContrast, mood.contrast || 1);
  gl.uniform1f(prog.u.uExposure, mood.exposure || 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
};

let __debugDot = null;
function WORLD_DEBUG_DOT() {
  if (!__debugDot) {
    const { c, ctx } = TEXTURES.makeCanvas(2, 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 2, 2);
    __debugDot = c;
  }
  return __debugDot;
}

// ------------------------------------------------------------------ shaders

// One convention for every full-screen pass: vUV is the screen row, measured
// from the top, so sampling a render target at vUV lands on the same screen
// row it came from. There is no flip here. A flip here mirrors every image
// that is sampled, while sprites drawn straight into the target keep their own
// orientation, which put pads, flowers and reeds on screen mirrored against
// the pads' own positions.
const FLAT_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const SPRITE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aLocal;
uniform vec2 uRes;
uniform vec2 uPos;
uniform vec2 uSize;
uniform float uRot;
uniform vec4 uTint;
uniform float uFlipV;
out vec2 vUV;
out vec4 vTint;
out vec2 vWorld;
void main() {
  float c = cos(uRot);
  float s = sin(uRot);
  vec2 lp = aLocal * uSize;
  vec2 world = vec2(lp.x * c - lp.y * s, lp.x * s + lp.y * c) + uPos;
  gl_Position = vec4(world.x / uRes.x * 2.0 - 1.0, 1.0 - world.y / uRes.y * 2.0, 0.0, 1.0);
  float vy = aLocal.y + 0.5;
  vUV = vec2(aLocal.x + 0.5, uFlipV > 0.5 ? 1.0 - vy : vy);
  vTint = uTint;
  vWorld = world;
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUV;
in vec4 vTint;
out vec4 outColor;
void main() {
  vec4 t = texture(uTex, vUV);
  if (t.a < 0.5) discard;
  outColor = vec4(t.rgb * vTint.rgb, t.a * vTint.a);
}`;

// The fish is not drawn as a resampled sprite: every fragment walks the
// spine, finds the closest point on it, and reads the painted texture by
// (arclength, lateral offset). Sampling coordinates are derived from whole
// world pixels, so a turning fish shifts its pattern by whole pixels instead
// of shattering 1px outlines and eyes the way ordinary sprite rotation does.
const FISH_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSprite;
uniform sampler2D uSpine;   // RGBA32F, one texel per node: x, y, arclength 0..1
uniform sampler2D uExt;     // RG32F, one texel per sprite column: top, bottom
uniform int uSpineN;
uniform float uSpriteW;
uniform float uSpriteH;
uniform float uScale;
uniform float uVC;
uniform vec2 uOffset;
uniform vec4 uTint;
uniform float uDeepTint;
uniform vec3 uDeepColor;
uniform float uRim[64];
uniform vec4 uPond;
in vec2 vWorld;
out vec4 outColor;

float rimFactorFish(float angle) {
  float f = (angle / 6.28318530718 + 0.5) * 64.0;
  float fr = f - floor(f);
  int i0 = int(floor(f));
  int a = ((i0 % 64) + 64) % 64;
  int b = (a + 1) % 64;
  return mix(uRim[a], uRim[b], fr);
}

float pondDFish(vec2 p) {
  vec2 q = (p - uPond.xy) / uPond.zw;
  return length(q) / max(rimFactorFish(atan(q.y, q.x)), 0.001);
}

void main() {
  vec2 p = vWorld + uOffset;
  if (pondDFish(p) > 1.02) discard;

  float bestDist = 1e9;
  float bestU = 0.0;
  float bestSide = 1.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uSpineN - 1) break;
    vec4 a = texelFetch(uSpine, ivec2(i, 0), 0);
    vec4 b = texelFetch(uSpine, ivec2(i + 1, 0), 0);
    vec2 ab = b.xy - a.xy;
    float denom = max(dot(ab, ab), 1e-4);
    float t = clamp(dot(p - a.xy, ab) / denom, 0.0, 1.0);
    vec2 c = a.xy + ab * t;
    float dist = distance(p, c);
    if (dist < bestDist) {
      bestDist = dist;
      bestU = mix(a.z, b.z, t);
      bestSide = (ab.x * (p.y - c.y) - ab.y * (p.x - c.x)) >= 0.0 ? 1.0 : -1.0;
    }
  }

  // Fragments past the last spine node are not fish: the spine stops at the
  // tail. Without this they all project onto that node and sample the sprite's
  // final column at ever larger lateral offsets, which paints a ring around the
  // tail tip. That ring is what made every tail look joined at the end.
  vec4 lastNode = texelFetch(uSpine, ivec2(uSpineN - 1, 0), 0);
  vec4 prevNode = texelFetch(uSpine, ivec2(max(uSpineN - 2, 0), 0), 0);
  vec2 tailDir = lastNode.xy - prevNode.xy;
  float tailLen = length(tailDir);
  if (tailLen > 0.001) {
    float beyond = dot(p - lastNode.xy, tailDir / tailLen);
    if (beyond > 0.35) discard;
  }
  // and nothing in front of the snout either
  vec4 firstNode = texelFetch(uSpine, ivec2(0, 0), 0);
  vec4 secondNode = texelFetch(uSpine, ivec2(1, 0), 0);
  vec2 headDir = firstNode.xy - secondNode.xy;
  float headLen = length(headDir);
  if (headLen > 0.001) {
    float ahead = dot(p - firstNode.xy, headDir / headLen);
    if (ahead > 0.35) discard;
  }

  float lateral = bestDist * bestSide / max(uScale, 0.001);
  float col = clamp(bestU, 0.0, 1.0) * (uSpriteW - 1.0);
  float c0 = floor(col);
  float cf = col - c0;
  vec2 e0 = texelFetch(uExt, ivec2(int(c0), 0), 0).rg;
  vec2 e1 = texelFetch(uExt, ivec2(int(min(c0 + 1.0, uSpriteW - 1.0)), 0), 0).rg;
  vec2 ext = mix(e0, e1, cf) * uSpriteH;
  float limit = lateral < 0.0 ? ext.x : ext.y;
  if (abs(lateral) > limit) discard;

  float v = uVC + lateral / uSpriteH;
  vec4 texel = texture(uSprite, vec2(bestU, v));
  if (texel.a < 0.5) discard;
  vec3 rgb = texel.rgb * uTint.rgb;
  rgb = mix(rgb, rgb * uDeepColor, uDeepTint);
  outColor = vec4(rgb, texel.a * uTint.a);
}`;

const BED_VS = FLAT_VS;

const BED_FS = `#version 300 es
${GLSL_COMMON}
uniform vec3 uSand, uMud, uDeep, uAlgae, uPebble;
uniform float uCaustics;
in vec2 vUV;
out vec4 outColor;

void main() {
  // vUV comes in bottom-up (GL): 0 at the bottom of the target, 1 at the top.
  // World y counts down from the top, so un-flip to get a pond position.
  // Sampling a target at plain vUV is a straight copy, which is what keeps
  // sprites and the water in the same place.
  vec2 p = vec2(vUV.x, 1.0 - vUV.y) * uRes;
  float d = pondD(p);
  vec2 g = ringDisp(p) * 1.4 + swellGrad(p) * 6.0;

  // --- the floor of the pond, all the way to the frame ---
  // d is 0 at the deepest point and rises toward the edges
  float mottle = vnoise(p * 0.05) * 0.62 + vnoise(p * 0.13 + 7.3) * 0.38;
  // Basin-scale variation. Deliberately much larger than any other feature on
  // the bed: this is the scale that reads as depth, and without it the floor
  // is one even tone however much fine texture sits on top of it.
  float basin = vnoise(p * 0.0075 + 12.0) * 0.66 + vnoise(p * 0.019 + 45.0) * 0.34;

  vec3 floorCol = mix(uSand, uMud, smoothstep(0.34, 0.78, mottle));
  // Two stages of drop. The frame crops the middle of a much larger pond, so
  // the ramp is compressed into the depths that are actually on screen: a
  // shelf just past the shallows, then a steeper fall into the basin, so the
  // middle sits a whole tone below the edge instead of meeting it halfway.
  float dsh = 1.0 - d;
  float shelf = smoothstep(0.04, 0.26, dsh);
  float drop = smoothstep(0.2, 0.58, dsh);
  floorCol = mix(floorCol, shadeRgb3(uDeep, 1.2), shelf * 0.85);
  floorCol = mix(floorCol, uDeep, drop * 0.92);
  // patchiness inside the basin, or the deep reads as a flat navy disc
  floorCol = mix(floorCol, shadeRgb3(uDeep, 0.84), smoothstep(0.42, 0.9, basin) * drop * 0.75);
  // pale silt fans where the shallows spill over the shelf
  floorCol = mix(floorCol, shadeRgb3(uSand, 1.16), smoothstep(0.52, 0.86, basin) * (1.0 - shelf) * 0.4);
  // and a broad lit side: the floor near the sun is a shade brighter than the
  // floor on the far side, which is what gives the bed a sense of tilt
  const vec2 sun2d = vec2(-0.54, -0.84);   // matches CONFIG.sun.dir
  float litSide = clamp(dot((p / uRes - 0.5) * 2.0, sun2d) * 0.5 + 0.5, 0.0, 1.0);
  floorCol *= 0.9 + litSide * 0.2;
  // patches of settled algae and weed, in two scales, to break the field up
  float algae = smoothstep(0.55, 0.85, vnoise(p * 0.026 + 31.7));
  floorCol = mix(floorCol, uAlgae, algae * 0.3 * (1.0 - abs(d - 0.42) * 1.3));
  float weed = smoothstep(0.62, 0.92, vnoise(p * 0.058 + 71.3));
  floorCol = mix(floorCol, shadeRgb3(uAlgae, 0.78), weed * 0.22);
  // pebbles, thicker where the floor shelves up
  vec2 cell = floor(p / 8.0);
  vec2 cellLocal = fract(p / 8.0) - 0.5;
  float pebble = hash12(cell + 11.0);
  float pebbleDist = length(cellLocal * vec2(1.0, 0.72));
  float pebbleMask = step(0.88, pebble) * (1.0 - smoothstep(0.24, 0.34, pebbleDist)) * smoothstep(0.3, 0.6, d);
  floorCol = mix(floorCol, mix(uPebble, uSand, 0.35), pebbleMask * 0.85);
  // fine sand ripples in the shallows
  // silt ripples: wavelength and heading both drift across the floor, so the
  // pond bed never reads as parallel hatching
  float ripWarp = vnoise(p * 0.011 + 3.0) * 11.0 + vnoise(p * 0.038 + 17.0) * 3.0;
  float ripples = sin(p.x * 0.05 + p.y * 0.032 + ripWarp);
  floorCol *= 1.0 + ripples * 0.028 * smoothstep(0.32, 0.62, d);

  // caustics: two drifting noise fields, bright where their difference is
  // small. The clock steps in whole frames so the light net never crawls
  // through sub-pixel positions and shimmers.
  // Light focused by the wavy surface. Brightness follows the surface
  // curvature, so the light net drifts with the very waves that make it
  // instead of crawling on its own clock, and its cells are round and
  // connected the way real caustics are.
  // Caustics, the nagomi shape: a mosaic of irregular cells with the light
  // gathered along the seams between them. Thin pale lines, low contrast, so
  // it reads as light lying in the water instead of a pattern on the floor.
  // The cells drift slowly, wobble through a noise warp, and keep a constant
  // size in pixels rather than in world units.
  float cs = uRes.x / 320.0;
  vec2 cq = (p + g * 2.0) * 0.036 * cs;
  cq += vec2(uTime * 0.035, uTime * 0.022);
  // a gentle warp only: too much and the seams break into dashes
  cq += (vec2(vnoise(cq * 0.4 + 3.0), vnoise(cq * 0.4 + 11.0)) - 0.5) * 0.34;
  vec2 cn = floor(cq);
  vec2 cf = fract(cq);
  float d1 = 9.0;
  float d2 = 9.0;
  float cellVary = 1.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = causticHash(cn + vec2(float(i), float(j)));
      vec2 r = vec2(float(i), float(j)) + o - cf;
      float dd = dot(r, r);
      if (dd < d1) { d2 = d1; d1 = dd; cellVary = o.x; } else if (dd < d2) { d2 = dd; }
    }
  }
  float edge = sqrt(d2) - sqrt(d1);   // zero along the seam between two cells
  float caust = pow(1.0 - smoothstep(0.0, 0.075, edge), 1.35);
  // not every cell's rim lights up the same, or the net looks printed
  caust *= 0.55 + 0.85 * cellVary;
  // the swell still decides how bright the seams burn
  float lap = swellLap(p + g * 2.0) * 2.2;
  caust *= 0.55 + 0.75 * clamp(lap * 1.1 + 0.45, 0.0, 1.5);
  caust *= 0.15 + 0.85 * pow(clamp(d * 1.6, 0.0, 1.0), 1.5);
  floorCol += uSun * caust * uCaustics * 1.4;

  // slow diagonal shafts of light: one broad, soft band rather than streaks
  float shaft = sin(dot(p, normalize(vec2(-0.55, -0.75))) * 0.0185 + vnoise(p * 0.021) * 3.4 + uTime * 0.07);
  float shaftB = sin(dot(p, normalize(vec2(0.46, -0.68))) * 0.0132 + vnoise(p * 0.014 + 41.0) * 3.0 - uTime * 0.05);
  floorCol += uSun * (smoothstep(0.62, 1.0, shaft) * 0.017 + smoothstep(0.7, 1.0, shaftB) * 0.013);

  outColor = vec4(floorCol, 1.0);
}`;

const WATER_FS = `#version 300 es
${GLSL_COMMON}
uniform sampler2D uUnder;
uniform float uBend, uMaxBend, uSpecular, uShallowLift, uShallowMix;
uniform vec3 uDeepTint;
uniform vec3 uShallowColor;
uniform vec2 uLight;
in vec2 vUV;
out vec4 outColor;

void main() {
  // vUV is bottom-up: 0 at the bottom of the target. World y counts down from
  // the top, so the pond position of this fragment is the un-flipped vUV.
  vec2 p = vec2(vUV.x, 1.0 - vUV.y) * uRes;
  float d = pondD(p);
  float mask = 1.0 - smoothstep(0.965, 1.03, d);

  // The swell bends what sits under it, but only by a fraction of a pixel:
  // a large coherent offset drags the floor sideways along every wavefront
  // and the pond reads as parallel hatching. Instead the offset is kept
  // sub-pixel and dithered per pixel, so the water looks alive without bands.
  float jt = floor(uTime * 7.0) * (1.0 / 7.0);
  vec2 jitter = (vec2(vnoise(p * 0.29 + jt), vnoise(p * 0.31 + 17.0 - jt)) - 0.5) * 1.25;
  vec2 disp = (ringDisp(p) * uBend * 0.6 + swellGrad(p) * 6.0 + jitter) * mask;
  disp = clamp(disp, vec2(-uMaxBend), vec2(uMaxBend));
  disp = floor(disp + 0.5);                       // whole pixels only
  // disp is in pond pixels with y counting down; v counts up, so the y part of
  // the offset is negated. Without this the refraction pulls the image the
  // wrong way vertically, which is what put a pad's ripple above the pad.
  vec3 col = texture(uUnder, vUV + vec2(disp.x, -disp.y) / uRes).rgb;

  // d is 0 in the middle of the pond and 1 at the shoreline: deep in the
  // middle, shallow at the edges, and a lift where the floor is close
  float rimT = clamp(d, 0.0, 1.0);
  float deepAmt = 1.0 - rimT;
  float shallowAmt = smoothstep(0.34, 0.7, rimT);
  col = mix(col, col * uDeepTint, smoothstep(0.03, 0.4, deepAmt) * 0.55 * mask);
  // the shallows keep their water colour instead of reading as bare sand
  col = mix(col, mix(col, uShallowColor, uShallowMix), shallowAmt * mask);
  col += vec3(uShallowLift) * shallowAmt * mask;

  // broad patches of light on the surface, drifting slowly
  float lightPatch = vnoise(p * 0.0128 + vec2(uTime * 0.007, -uTime * 0.005));
  float lightPatchB = vnoise(p * 0.031 - 7.0 + vec2(-uTime * 0.01, uTime * 0.008));
  col += uSun * ((lightPatch - 0.5) * 0.05 + (lightPatchB - 0.5) * 0.022) * mask * (0.3 + 0.7 * uSunPower);

  // ---- white shimmer -------------------------------------------------
  // Sun glint: where the swell tilts the surface so it throws the sun back
  // at the eye, the water goes white. The tilt comes from the swell slope,
  // so the glint travels with the waves; a slow noise field groups it into
  // patches so it never lines up into parallel streaks, and the levels are
  // quantised so it stays crisp pixel art.
  float gt = floor(uTime * 9.0) * (1.0 / 9.0);
  vec3 sunDir = normalize(vec3(normalize(uLight), 0.58));
  // fine surface noise does the breaking up: without it the glint just runs
  // along the wave crests and the pond looks hatched
  // Tiny wavelets whose crests face the sun. The glint lands on their lit
  // faces, which is why sunlight on water reads as short dashes pointing at
  // the sun rather than as speckle or as parallel lines: the dash direction
  // follows the light, the dash length comes from the noise, and both the
  // wavelet phase and the patch masks wander.
  float az = atan(uLight.y, uLight.x);
  vec2 along = vec2(cos(az), sin(az));
  vec2 across = vec2(-along.y, along.x);
  float wavelet = sin(dot(p, across) * 0.42 + vnoise(p * 0.058) * 5.2 + gt * 1.15);
  float waveletB = sin(dot(p, across) * 0.83 + vnoise(p * 0.11 + 4.0) * 4.4 - gt * 1.7);
  vec2 fine = vec2(vnoise(p * 0.38 + gt * 0.3), vnoise(p * 0.41 + 23.0 - gt * 0.27)) - 0.5;
  vec2 tilt = swellGrad(p) * 14.0 + along * (wavelet * 19.0 + waveletB * 9.0) + fine * 8.0;
  vec3 nrm = normalize(vec3(tilt, 1.0));
  float glint = pow(max(dot(nrm, sunDir), 0.0), 18.0);
  // break the lit streaks along their length, or they read as painted bands
  float dash = smoothstep(0.3, 0.76, vnoise(p * 0.185 + vec2(gt * 0.25, -gt * 0.22)));
  // three scales of mask: broad calm water, patches that glint, and a slow
  // breath inside them. Together they keep the pond from sparkling evenly.
  float broad = smoothstep(0.34, 0.66, vnoise(p * 0.0135 + vec2(gt * 0.032, -gt * 0.024)));
  float patches = smoothstep(0.40, 0.68, vnoise(p * 0.052 + vec2(gt * 0.07, -gt * 0.055)));
  float micro = 0.40 + 0.60 * vnoise(p * 0.21 - gt * 0.19);
  // Wider masks than before: the glints cover more of the pond instead of
  // gathering in a couple of patches.
  glint *= broad * patches * micro * dash * 5.9;
  // A second glint field on its own slower clock, so twice as many dashes are
  // moving at any moment and they never pulse in step with the first set.
  float gt2 = floor(uTime * 6.0) / 6.0;
  float waveletC = sin(dot(p, across) * 0.61 + vnoise(p * 0.077 + 9.0) * 5.0 + gt2 * 1.35);
  vec2 tilt2 = swellGrad(p) * 11.0 + along * waveletC * 16.0 + fine * 6.0;
  vec3 nrm2 = normalize(vec3(tilt2, 1.0));
  float glint2 = pow(max(dot(nrm2, sunDir), 0.0), 20.0);
  glint2 *= smoothstep(0.36, 0.70, vnoise(p * 0.033 + vec2(gt2 * 0.05, -gt2 * 0.04))) * micro * 5.4;
  glint = floor(clamp(max(glint, glint2 * 0.55), 0.0, 1.0) * 3.0) / 3.0;
  // a modest veil: dashes of light, never fog
  col = mix(col, vec3(0.97, 0.995, 0.96), glint * 0.52 * mask * uSunPower);

  // plus the small hard sparkles that blink between whole frames
  float gl = vnoise(p * 0.23 + vec2(gt * 0.9, -gt * 0.62));
  // sparse but bright: a low threshold here lifts the whole pond into haze
  float sparkle = pow(max(gl - 0.76, 0.0) * 8.0, 2.2);
  float energy = clamp(length(disp) / 6.0, 0.0, 1.0);
  col += uSun * sparkle * (0.055 + 0.55 * energy) * mask * uSunPower;

  // A ripple crest is where the light lands: a bright line along the crest,
  // a thin shadow on its trailing face, and extra sheen on the sun side.
  // Reading the crest straight off the rings keeps the highlight on the wave
  // instead of letting the refraction drag dark floor around, which is what
  // made clicks look like grooves cut into the water.
  float crest = clamp(ringCrest(p, 0.0), 0.0, 1.4);
  float crestShadow = clamp(ringCrest(p, 2.4), 0.0, 1.2);
  col += uSun * crest * 0.24 * mask * (0.35 + 0.65 * uSunPower);
  col *= 1.0 - crestShadow * 0.16 * mask;
  vec2 crestNormal = normalize(disp + vec2(1e-5, 1e-5));
  col += uSun * crest * max(dot(crestNormal, normalize(uLight)), 0.0) * uSpecular * 0.9 * mask * uSunPower;

  outColor = vec4(col, 1.0);
}`;

const BRIGHT_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uThreshold, uGain, uKnee;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec3 c = (texture(uScene, vUV + vec2(-uTexel.x, -uTexel.y)).rgb
    + texture(uScene, vUV + vec2(uTexel.x, -uTexel.y)).rgb
    + texture(uScene, vUV + vec2(-uTexel.x, uTexel.y)).rgb
    + texture(uScene, vUV + vec2(uTexel.x, uTexel.y)).rgb) * 0.25;
  // soft knee: a hard cut makes every highlight pop on and off as it crosses
  // the threshold, a knee fades them in and keeps the bloom from strobing
  float l = max(max(c.r, c.g), c.b);
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float take = max(soft, l - uThreshold) / max(l, 1e-4);
  outColor = vec4(c * take * uGain, 1.0);
}`;

// Separable Gaussian, five taps each way, run twice: once across, once down.
// uDir picks the axis and uSpread the radius, so the same shader does the tight
// bloom and the wide glow without a second program.
const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uSpread;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec2 o = uTexel * uDir * uSpread;
  vec3 c = texture(uTex, vUV).rgb * 0.227027;
  c += (texture(uTex, vUV + o * 1.3846).rgb + texture(uTex, vUV - o * 1.3846).rgb) * 0.316216;
  c += (texture(uTex, vUV + o * 3.2308).rgb + texture(uTex, vUV - o * 3.2308).rgb) * 0.070270;
  outColor = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uGlow;
uniform vec2 uRes;
uniform float uTime;
uniform float uStrength, uVignette;
uniform float uGlowStrength;
uniform float uCloudShade, uCloudScale, uCloudDrift;
uniform vec3 uWarm;
uniform vec3 uSkyTop, uSkyBot;
uniform float uMoodAmt, uMist, uGlint;
uniform float uSkyLift;
uniform float uCloudSoft;
uniform float uMoon;
uniform vec3 uMoonCol;
uniform vec3 uGlintCol;
uniform float uDesat;
uniform float uContrast, uExposure;
in vec2 vUV;
out vec4 outColor;

// This pass does not include the shared GLSL block, so it carries its own
// copy of the value noise the shade field is built from.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  local = local * local * (3.0 - 2.0 * local);
  float a = hash12(cell);
  float b = hash12(cell + vec2(1.0, 0.0));
  float c = hash12(cell + vec2(0.0, 1.0));
  float d = hash12(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, local.x), mix(c, d, local.x), local.y);
}

float cloudFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + 17.0;
    a *= 0.5;
  }
  return s / 0.9375;
}

// two independent slow wanders, one at half scale, so the field never slides
// along one straight line
vec2 cloudWander(vec2 p, float t) {
  return vec2(sin(t * 0.05 + p.y * 0.8), cos(t * 0.04 + p.x * 0.6)) * 0.5
       + vec2(sin(t * 0.023 + 1.7), cos(t * 0.036 + 0.4)) * 0.5;
}

// A drifting shadow field with no cloud drawn anywhere. Two fbm octaves at
// different scales make the mass outline, a third makes the billows inside it,
// and a smoothstep lifts the dense cores. That is what makes it read as the
// shadow of a cloud instead of a stain or a round blob.
float cloudShadow(vec2 p, float t) {
  vec2 q = p + cloudWander(p, t) * 0.18 + cloudWander(p * 0.5, t * 0.7) * 0.15;
  q += vec2(sin(q.y * 1.7 + t * 0.05), cos(q.x * 1.3 + t * 0.04)) * 0.05;
  float clumps = cloudFbm(q * 1.35 + vec2(t * 0.008, -t * 0.006) + 4.7);
  float clumps2 = cloudFbm(q * 0.85 + vec2(-t * 0.006, t * 0.009) + 19.3);
  float broad = max(smoothstep(0.42, 0.75, clumps),
                    smoothstep(0.48, 0.78, clumps2) * 0.85);
  float billow = cloudFbm(q * 3.0 + vec2(-t * 0.01, t * 0.008));
  float sh = broad * (0.60 + 0.40 * billow);
  sh += smoothstep(0.50, 0.95, sh) * 0.26;
  return min(sh, 0.80);
}

void main() {
  vec3 col = texture(uScene, vUV).rgb
    + texture(uBloom, vUV).rgb * uStrength
    + texture(uGlow, vUV).rgb * uGlowStrength;
  // vUV is bottom-up; world y counts down, so un-flip for the shade field.
  vec2 p = vec2(vUV.x, 1.0 - vUV.y) * uRes;
  // The field is sampled on a two-pixel grid, so the boundary moves in chunky
  // steps the size of the pond's own pixels instead of a one-pixel contour
  // that reads as a soft edge once the canvas is scaled up.
  vec2 cp = (floor(p * 0.5) + 0.5) * 2.0;
  float shade = cloudShadow(cp * uCloudScale, uTime * uCloudDrift);
  // Pixel art, not photography: two flat tones with hard edges, the way a
  // shadow is painted into a tile. The outer tone carries the shape, the inner
  // one marks the dense core of the mass.
  float shadeHard = shade > 0.62 ? 1.0 : (shade > 0.26 ? 0.6 : 0.0);
  // Overcast has no hard cloud edges: the whole sky is one diffuser, so the
  // shade has to be a smooth ramp instead of the two painted tones. Blending
  // between the two keeps sunny and sunset exactly as they were.
  float shadeSoft = smoothstep(0.18, 0.82, shade);
  shade = mix(shadeHard, shadeSoft, uCloudSoft);
  // and it cools the water rather than just dimming it, the way shade on water
  // goes blue-grey under a white sun
  col *= 1.0 - shade * uCloudShade * vec3(1.08, 0.98, 0.86);
  col *= uWarm;
  // vUV.y = 0 is the BOTTOM of the frame in this pass, so every falloff from the
  // top has to climb with vy, not with 1 - vy
  float vy = clamp(vUV.y, 0.0, 1.0);
  float topMask = pow(vy, 1.45);
  // two stops, not one colour: whatever is picked for the top fades into
  // whatever is picked for the bottom as the frame comes down
  vec3 grad = mix(uSkyBot, uSkyTop, topMask);
  col = mix(col, col * grad, uMoodAmt);
  // A multiply-only veil can darken water but never brighten it, so a bright
  // overcast sky left the pond as dark as a rainy one. Lift the water toward
  // the sky colour instead, most of it toward the top of the frame where the
  // sky is actually reflected.
  if (uSkyLift > 0.001) {
    // concentrated toward the top of the frame and the brightest water: a
    // blanket lift washed every colour in the pond toward white
    float liftW = pow(topMask, 2.0);
    float luma0 = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float specW = smoothstep(0.20, 0.75, luma0);
    col = mix(col, grad, uSkyLift * liftW * (0.45 + 0.55 * specW));
  }
  // low sun catching the water: warm light on the brightest pixels, strongest
  // toward the top where the sun is
  if (uGlint > 0.001) {
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float glint = smoothstep(0.52, 0.92, luma) * uGlint * (0.30 + 0.70 * topMask);
    col += uGlintCol * glint * 0.6;
  }
  // mist: two drifting layers, thick toward the top and thinner down the frame,
  // never zero at the bottom because mist fills the air rather than pooling at
  // one edge
  // heavy weather drains colour: nothing looks right in moonlight with bright
  // green lily pads in it
  if (uDesat > 0.001) {
    col = mix(col, vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), uDesat);
  }
  if (uMist > 0.001) {
    float m1 = cloudFbm(vec2(p.x * 0.0035 + uTime * 0.010, p.y * 0.0075 - uTime * 0.003));
    float m2 = cloudFbm(vec2(p.x * 0.0110 - uTime * 0.018, p.y * 0.0160 + uTime * 0.006) + 31.0);
    float m = m1 * 0.68 + m2 * 0.32;
    // Mist hangs in the air above the water: nearly all of it belongs at the
    // top of the frame. An even veil over the whole picture just made the pond
    // look like it had been photographed through greased glass.
    float weight = 0.10 + 0.90 * pow(vy, 1.9);
    float veil = smoothstep(0.34, 0.86, m) * uMist * weight;
    col = mix(col, vec3(0.87, 0.91, 0.90), veil * 0.55);
    // distance wash: the far water loses contrast in thick air
    // The distance wash used to pull colour out of the whole frame, which
    // dropped the contrast along with the saturation. A little is enough: the
    // haze itself already does the softening.
    col = mix(col, vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), uMist * 0.04 * weight);
  }
  // ---- the moon ----------------------------------------------------------
  // A top-down pond has no sky to hang a moon in, so moonlight has to arrive as
  // light on the water: one broad cool pool with a bright core, upper right,
  // plus a very faint wash over everything so the whole frame reads moonlit and
  // not just one corner.
  if (uMoon > 0.001) {
    vec2 mp = vec2(0.68, 0.78);
    vec2 rel = vUV - mp;
    rel.x *= uRes.x / max(uRes.y, 1.0) * 0.62;
    float r = length(rel);
    float pool = exp(-r * 7.5) * 0.95 + exp(-r * 2.0) * 0.34;
    float sheet = smoothstep(0.05, 0.95, vUV.y) * 0.10;
    col += uMoonCol * (pool + sheet) * uMoon * 0.72;
  }

  // exposure and contrast last: tint alone only ever washes a picture, it cannot
  // make the darks deep or the highlights hot
  col *= uExposure;
  col = (col - 0.5) * uContrast + 0.5;
  vec2 q = vUV - 0.5;
  col *= 1.0 - uVignette * pow(clamp(length(q) * 1.5, 0.0, 1.0), 2.2);
  outColor = vec4(col, 1.0);
}`;
