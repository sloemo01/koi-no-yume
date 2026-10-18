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
  this.targets = {
    under: make(w, h),
    scene: make(w, h),
    bloomA: make(bw, bh),
    bloomB: make(bw, bh),
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
  const n = Math.min(rings.length, MAX_RINGS);
  const packed = new Float32Array(MAX_RINGS * 4);
  const packedK = new Float32Array(MAX_RINGS);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const ring = rings[i];
    if (!ring.alive || ring.age <= 0 || Math.abs(ring.amp) <= 0.001) continue;
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
  gl.uniform1f(u.uCaustics, CONFIG.caustics.amp);
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
  // bright pass
  let prog = this.programs.bright;
  gl.useProgram(prog.program);
  gl.bindVertexArray(this.quadVao);
  gl.bindFramebuffer(gl.FRAMEBUFFER, bw.fbo);
  gl.viewport(0, 0, bw.w, bw.h);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this.targets.scene.tex);
  gl.uniform1i(prog.u.uScene, 0);
  gl.uniform2f(prog.u.uTexel, 1 / this.width, 1 / this.height);
  gl.uniform1f(prog.u.uThreshold, CONFIG.bloom.threshold);
  gl.uniform1f(prog.u.uGain, CONFIG.bloom.gain);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // blur
  prog = this.programs.blur;
  gl.useProgram(prog.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets.bloomB.fbo);
  gl.bindTexture(gl.TEXTURE_2D, bw.tex);
  gl.uniform1i(prog.u.uTex, 0);
  gl.uniform2f(prog.u.uTexel, 1 / bw.w, 1 / bw.h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // composite to the canvas
  prog = this.programs.composite;
  gl.useProgram(prog.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, this.width, this.height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this.targets.scene.tex);
  gl.uniform1i(prog.u.uScene, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, this.targets.bloomB.tex);
  gl.uniform1i(prog.u.uBloom, 1);
  gl.uniform2f(prog.u.uRes, this.width, this.height);
  gl.uniform1f(prog.u.uStrength, CONFIG.bloom.strength);
  gl.uniform1f(prog.u.uVignette, CONFIG.vignette);
  const cl = world.clouds;
  gl.uniform4f(prog.u.uCloudA, cl[0] ? cl[0].x : -1e5, cl[0] ? cl[0].y : -1e5, cl[0] ? cl[0].r : 1, cl[0] ? cl[0].shade : 0);
  gl.uniform4f(prog.u.uCloudB, cl[1] ? cl[1].x : -1e5, cl[1] ? cl[1].y : -1e5, cl[1] ? cl[1].r : 1, cl[1] ? cl[1].shade : 0);
  gl.uniform3f(prog.u.uWarm, 1.0, 0.995, 0.972);
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

const FLAT_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  vUV.y = 1.0 - vUV.y;
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
  // vUV starts at the bottom of the frame buffer, but every world position in
  // this project (rings, fish, pads, clouds) counts y down from the top. Flip
  // here or the water features come out mirrored against everything drawn as
  // a sprite, which is what put ripples on the wrong side of a click.
  vec2 p = vec2(vUV.x, 1.0 - vUV.y) * uRes;
  float d = pondD(p);
  vec2 g = ringDisp(p) * 1.4 + swellGrad(p) * 6.0;

  // --- the floor of the pond, all the way to the frame ---
  // d is 0 at the deepest point and rises toward the edges
  float mottle = vnoise(p * 0.05) * 0.62 + vnoise(p * 0.13 + 7.3) * 0.38;
  vec3 floorCol = mix(uSand, uMud, smoothstep(0.34, 0.78, mottle));
  floorCol = mix(floorCol, uDeep, smoothstep(0.03, 0.5, 1.0 - d) * 0.94);
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
  // vUV starts at the bottom of the frame buffer, but every world position in
  // this project (rings, fish, pads, clouds) counts y down from the top. Flip
  // here or the water features come out mirrored against everything drawn as
  // a sprite, which is what put ripples on the wrong side of a click.
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
  vec3 col = texture(uUnder, vUV + disp / uRes).rgb;

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
  col += uSun * ((lightPatch - 0.5) * 0.05 + (lightPatchB - 0.5) * 0.022) * mask;

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
  float broad = smoothstep(0.26, 0.62, vnoise(p * 0.0135 + vec2(gt * 0.032, -gt * 0.024)));
  float patches = smoothstep(0.30, 0.62, vnoise(p * 0.052 + vec2(gt * 0.07, -gt * 0.055)));
  float micro = 0.5 + 0.5 * vnoise(p * 0.21 - gt * 0.19);
  // Wider masks than before: the glints cover more of the pond instead of
  // gathering in a couple of patches.
  glint *= broad * patches * micro * dash * 6.4;
  // A second glint field on its own slower clock, so twice as many dashes are
  // moving at any moment and they never pulse in step with the first set.
  float gt2 = floor(uTime * 6.0) / 6.0;
  float waveletC = sin(dot(p, across) * 0.61 + vnoise(p * 0.077 + 9.0) * 5.0 + gt2 * 1.35);
  vec2 tilt2 = swellGrad(p) * 11.0 + along * waveletC * 16.0 + fine * 6.0;
  vec3 nrm2 = normalize(vec3(tilt2, 1.0));
  float glint2 = pow(max(dot(nrm2, sunDir), 0.0), 20.0);
  glint2 *= smoothstep(0.30, 0.66, vnoise(p * 0.033 + vec2(gt2 * 0.05, -gt2 * 0.04))) * micro * 5.2;
  glint = floor(clamp(max(glint, glint2 * 0.9), 0.0, 1.0) * 3.0) / 3.0;
  col = mix(col, vec3(0.97, 0.995, 0.96), glint * 0.74 * mask);

  // plus the small hard sparkles that blink between whole frames
  float gl = vnoise(p * 0.23 + vec2(gt * 0.9, -gt * 0.62));
  // sparse but bright: a low threshold here lifts the whole pond into haze
  float sparkle = pow(max(gl - 0.735, 0.0) * 8.5, 2.2);
  float energy = clamp(length(disp) / 6.0, 0.0, 1.0);
  col += uSun * sparkle * (0.07 + 0.6 * energy) * mask;

  // A ripple crest is where the light lands: a bright line along the crest,
  // a thin shadow on its trailing face, and extra sheen on the sun side.
  // Reading the crest straight off the rings keeps the highlight on the wave
  // instead of letting the refraction drag dark floor around, which is what
  // made clicks look like grooves cut into the water.
  float crest = clamp(ringCrest(p, 0.0), 0.0, 1.4);
  float crestShadow = clamp(ringCrest(p, 2.4), 0.0, 1.2);
  col += uSun * crest * 0.24 * mask;
  col *= 1.0 - crestShadow * 0.16 * mask;
  vec2 crestNormal = normalize(disp + vec2(1e-5, 1e-5));
  col += uSun * crest * max(dot(crestNormal, normalize(uLight)), 0.0) * uSpecular * 0.9 * mask;

  outColor = vec4(col, 1.0);
}`;

const BRIGHT_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uThreshold, uGain;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec3 c = (texture(uScene, vUV + vec2(-uTexel.x, -uTexel.y)).rgb
    + texture(uScene, vUV + vec2(uTexel.x, -uTexel.y)).rgb
    + texture(uScene, vUV + vec2(-uTexel.x, uTexel.y)).rgb
    + texture(uScene, vUV + vec2(uTexel.x, uTexel.y)).rgb) * 0.25;
  float l = max(max(c.r, c.g), c.b);
  outColor = vec4(c * max(l - uThreshold, 0.0) * uGain / max(l, 0.0001), 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec2 o1 = uTexel * 1.5;
  vec2 o2 = uTexel * 3.5;
  vec3 c = texture(uTex, vUV).rgb * 0.25;
  c += (texture(uTex, vUV + vec2(o1.x, 0.0)).rgb + texture(uTex, vUV - vec2(o1.x, 0.0)).rgb
    + texture(uTex, vUV + vec2(0.0, o1.y)).rgb + texture(uTex, vUV - vec2(0.0, o1.y)).rgb) * 0.125;
  c += (texture(uTex, vUV + vec2(o2.x, o2.y)).rgb + texture(uTex, vUV - vec2(o2.x, o2.y)).rgb
    + texture(uTex, vUV + vec2(o2.x, -o2.y)).rgb + texture(uTex, vUV - vec2(o2.x, -o2.y)).rgb) * 0.0625;
  outColor = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform float uStrength, uVignette;
uniform vec4 uCloudA, uCloudB;
uniform vec3 uWarm;
in vec2 vUV;
out vec4 outColor;

float cloudShade(vec4 cloud, vec2 p) {
  float d = distance(p, cloud.xy);
  return cloud.w * (1.0 - smoothstep(cloud.z * 0.3, cloud.z, d));
}

void main() {
  vec3 col = texture(uScene, vUV).rgb + texture(uBloom, vUV).rgb * uStrength;
  // vUV starts at the bottom of the frame buffer, but every world position in
  // this project (rings, fish, pads, clouds) counts y down from the top. Flip
  // here or the water features come out mirrored against everything drawn as
  // a sprite, which is what put ripples on the wrong side of a click.
  vec2 p = vec2(vUV.x, 1.0 - vUV.y) * uRes;
  float shade = cloudShade(uCloudA, p) + cloudShade(uCloudB, p);
  col *= 1.0 - clamp(shade, 0.0, 0.5);
  col *= uWarm;
  vec2 q = vUV - 0.5;
  col *= 1.0 - uVignette * pow(clamp(length(q) * 1.5, 0.0, 1.0), 2.2);
  outColor = vec4(col, 1.0);
}`;
