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
float swellH(vec2 p) {
  return (
    sin((p.x * 0.031 + p.y * 0.021) + uTime * 0.5464) * 0.5 +
    sin((p.y * 0.047 - p.x * 0.017) + uTime * 0.8607 + 1.7) * 0.32 +
    sin((p.x * 0.083 + p.y * 0.060) + uTime * 1.2823 + 4.1) * 0.18 +
    sin((p.x * 0.190 - p.y * 0.130) + uTime * 2.0268 + 0.9) * 0.30
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
    fish: this.makeProgram(FISH_VS, FISH_FS),
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
  if (!this.textureCache.has(canvasEl)) return;
  this.gl.deleteTexture(this.textureCache.get(canvasEl));
  this.textureCache.delete(canvasEl);
};

// a bendable mesh for one fish sprite: two vertices per spine node, plus the
// silhouette table, so fins and tails survive any bend
Gfx.prototype.createFishMesh = function (extents, nodes, spineRow, texH, texW) {
  const gl = this.gl;
  const verts = new Float32Array(nodes * 2 * 5);
  for (let i = 0; i < nodes; i++) {
    const u = nodes > 1 ? i / (nodes - 1) : 0;
    // widen to the tallest column in the neighbourhood so the outline never
    // breaks between nodes
    const col = Math.round(u * (texW - 1));
    let top = 0;
    let bot = 0;
    for (let c = Math.max(0, col - 2); c <= Math.min(texW - 1, col + 2); c++) {
      top = Math.max(top, extents[c * 2]);
      bot = Math.max(bot, extents[c * 2 + 1]);
    }
    const vc = spineRow / texH;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const o = (i * 2 + s) * 5;
      verts[o] = u;
      verts[o + 1] = side;
      verts[o + 2] = top;
      verts[o + 3] = bot;
      verts[o + 4] = vc;
    }
  }
  const indices = new Uint16Array((nodes - 1) * 6);
  for (let i = 0; i < nodes - 1; i++) {
    const a = i * 2;
    const o = i * 6;
    indices[o] = a;
    indices[o + 1] = a + 1;
    indices[o + 2] = a + 2;
    indices[o + 3] = a + 1;
    indices[o + 4] = a + 3;
    indices[o + 5] = a + 2;
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 4);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 8);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 20, 12);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 20, 16);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: indices.length, nodes };
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
    if (!ring.alive || ring.age <= 0 || ring.amp <= 0.001) continue;
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

Gfx.prototype.setPondFrame = function (world) {
  const gl = this.gl;
  const prog = this.programs.fish;
  gl.useProgram(prog.program);
  gl.uniform1fv(prog.u.uRim, world.rimTable);
  gl.uniform4f(prog.u.uPond, world.pond.cx, world.pond.cy, world.pond.rx, world.pond.ry);
};

Gfx.prototype.drawFish = function (mesh, canvasEl, spine, opts) {
  const gl = this.gl;
  const prog = this.programs.fish;
  gl.useProgram(prog.program);
  const u = prog.u;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this.tex(canvasEl));
  gl.uniform1i(u.uTex, 0);
  gl.uniform2f(u.uRes, this.width, this.height);
  const flat = new Float32Array(MAX_SPINE * 2);
  const n = Math.min(spine.length, MAX_SPINE);
  for (let i = 0; i < n; i++) {
    flat[i * 2] = spine[i].x;
    flat[i * 2 + 1] = spine[i].y;
  }
  gl.uniform2fv(u.uSpine, flat);
  gl.uniform1i(u.uSpineN, n);
  gl.uniform1f(u.uTexH, opts.texH);
  gl.uniform1f(u.uScale, opts.scale || 1);
  gl.uniform1f(u.uWavePhase, opts.wavePhase || 0);
  gl.uniform1f(u.uWaveAmp, opts.waveAmp || 0);
  gl.uniform1f(u.uWaveK, opts.waveK || 0);
  gl.uniform4fv(u.uTint, opts.tint || [1, 1, 1, 1]);
  gl.uniform1f(u.uDeepTint, opts.deepTint || 0);
  gl.uniform3f(u.uDeepColor, CONFIG.water.deepTint[0], CONFIG.water.deepTint[1], CONFIG.water.deepTint[2]);
  gl.bindVertexArray(mesh.vao);
  gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
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
void main() {
  float c = cos(uRot);
  float s = sin(uRot);
  vec2 lp = aLocal * uSize;
  vec2 world = vec2(lp.x * c - lp.y * s, lp.x * s + lp.y * c) + uPos;
  gl_Position = vec4(world.x / uRes.x * 2.0 - 1.0, 1.0 - world.y / uRes.y * 2.0, 0.0, 1.0);
  float vy = aLocal.y + 0.5;
  vUV = vec2(aLocal.x + 0.5, uFlipV > 0.5 ? 1.0 - vy : vy);
  vTint = uTint;
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

const FISH_VS = `#version 300 es
precision highp float;
layout(location = 0) in float aU;
layout(location = 1) in float aSide;
layout(location = 2) in float aTop;
layout(location = 3) in float aBot;
layout(location = 4) in float aVC;
uniform vec2 uRes;
uniform vec2 uSpine[${MAX_SPINE}];
uniform int uSpineN;
uniform float uTexH;
uniform float uScale;
uniform float uWavePhase;
uniform float uWaveAmp;
uniform float uWaveK;
uniform vec4 uTint;
out vec2 vUV;
out vec4 vTint;
out vec2 vWorld;
void main() {
  float fi = aU * float(uSpineN - 1);
  int i0 = int(floor(fi));
  int i1 = min(i0 + 1, uSpineN - 1);
  float fr = fi - float(i0);
  vec2 p0 = uSpine[i0];
  vec2 p1 = uSpine[i1];
  vec2 dir = normalize(p0 - p1 + vec2(1e-5, 1e-5));
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 pos = mix(p0, p1, fr);
  float wave = sin(uWavePhase - fi * uWaveK) * uWaveAmp * pow(clamp(aU, 0.0, 1.0), 1.4);
  pos += perp * wave;
  float ext = aSide < 0.0 ? aTop : aBot;
  pos += perp * aSide * ext * uTexH * uScale;
  gl_Position = vec4(pos.x / uRes.x * 2.0 - 1.0, 1.0 - pos.y / uRes.y * 2.0, 0.0, 1.0);
  vUV = vec2(aU, aVC + aSide * ext);
  vTint = uTint;
  vWorld = pos;
}`;

const FISH_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uDeepTint;
uniform vec3 uDeepColor;
uniform float uRim[64];
uniform vec4 uPond;
in vec2 vUV;
in vec4 vTint;
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
  // a fish under the water is hidden by the bank, never drawn over it
  if (pondDFish(vWorld) > 1.0) discard;
  vec4 t = texture(uTex, vUV);
  if (t.a < 0.5) discard;
  vec3 col = t.rgb * vTint.rgb;
  col = mix(col, col * uDeepColor, uDeepTint);
  outColor = vec4(col, t.a * vTint.a);
}`;

const BED_VS = FLAT_VS;

const BED_FS = `#version 300 es
${GLSL_COMMON}
uniform vec3 uSand, uMud, uDeep, uAlgae, uPebble;
uniform float uCaustics;
in vec2 vUV;
out vec4 outColor;

void main() {
  vec2 p = vUV * uRes;
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
  float ripples = sin(dot(p, normalize(vec2(0.7, 0.9))) * 0.22 + vnoise(p * 0.02) * 6.0);
  floorCol *= 1.0 + ripples * 0.028 * smoothstep(0.32, 0.62, d);

  // caustics: crossing noise fields; the bright net is where they agree
  vec2 cq1 = (p + g * 2.0) * 0.082 + vec2(uTime * 0.030, -uTime * 0.022);
  vec2 cq2 = (p + g * 2.0) * 0.072 + vec2(-uTime * 0.026, uTime * 0.034) + 23.7;
  float cn1 = vnoise(cq1) + 0.5 * vnoise(cq1 * 2.1 + 5.3);
  float cn2 = vnoise(cq2) + 0.5 * vnoise(cq2 * 1.9 + 9.1);
  float caust = pow(clamp(1.0 - abs(cn1 - cn2) * 2.6, 0.0, 1.0), 7.0);
  caust *= 0.15 + 0.85 * pow(clamp(d * 1.6, 0.0, 1.0), 1.5);
  floorCol += uSun * caust * uCaustics;

  // slow diagonal shafts of light: one broad, soft band rather than streaks
  float shaft = sin(dot(p, normalize(vec2(-0.55, -0.75))) * 0.021 + uTime * 0.09 + vnoise(p * 0.02) * 2.6);
  floorCol += uSun * smoothstep(0.55, 1.0, shaft) * 0.02;

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
  vec2 p = vUV * uRes;
  float d = pondD(p);
  float mask = 1.0 - smoothstep(0.965, 1.03, d);

  vec2 disp = (ringDisp(p) * uBend + swellGrad(p) * 26.0) * mask;
  disp = clamp(disp, vec2(-uMaxBend), vec2(uMaxBend));
  disp = floor(disp + 0.5);                       // whole pixels only
  vec3 col = texture(uUnder, vUV + disp / uRes).rgb;

  // d is 0 in the middle of the pond and 1 at the shoreline: deep in the
  // middle, shallow at the edges, and a lift where the floor is close
  float rimT = clamp(d, 0.0, 1.0);
  float deepAmt = 1.0 - rimT;
  float shallowAmt = smoothstep(0.34, 0.7, rimT);
  col = mix(col, col * uDeepTint, smoothstep(0.03, 0.4, deepAmt) * 0.64 * mask);
  // the shallows keep their water colour instead of reading as bare sand
  col = mix(col, mix(col, uShallowColor, uShallowMix), shallowAmt * mask);
  col += vec3(uShallowLift) * shallowAmt * mask;

  // one soft specular off the wave slope; no ring highlights
  vec2 n = normalize(disp + vec2(1e-5, 1e-5));
  float sheen = pow(max(dot(n, normalize(uLight)), 0.0), 4.0);
  col += uSun * sheen * uSpecular * mask * smoothstep(0.4, 1.4, length(disp));

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
  vec2 p = vUV * uRes;
  float shade = cloudShade(uCloudA, p) + cloudShade(uCloudB, p);
  col *= 1.0 - clamp(shade, 0.0, 0.5);
  col *= uWarm;
  vec2 q = vUV - 0.5;
  col *= 1.0 - uVignette * pow(clamp(length(q) * 1.5, 0.0, 1.0), 2.2);
  outColor = vec4(col, 1.0);
}`;
