/*
 * fluid.js — WebGL fluid "dye" that follows the cursor / finger.
 *
 * Based on Pavel Dobryakov's WebGL-Fluid-Simulation (MIT licence).
 * Same tuning as the original export, with these fixes:
 *   - ONE animation loop (the export started a second one on the first mouse move)
 *   - stops simulating when idle and restarts on the next movement (saves battery)
 *   - frees GPU textures when the window is resized (the export leaked them)
 *   - WebGL2 half-float textures are treated as linearly filterable, so iOS/Android
 *     keep full quality instead of dropping to a 256px, unshaded fallback
 *   - recovers from a lost WebGL context
 *
 * Needs:   <canvas id="fluid"></canvas> covering the viewport (position: fixed)
 * Exposes: window.Fluid = { burst(rect), splat(x, y, dx, dy, color), enabled }
 */
(function () {
  'use strict';

  var canvas = document.getElementById('fluid');
  if (!canvas) return;

  var mq = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };
  var reduceMotion = mq('(prefers-reduced-motion: reduce)');
  var coarsePointer = mq('(pointer: coarse)');

  var CONFIG = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: coarsePointer ? 512 : 1024,
    DENSITY_DISSIPATION: 2.2,   // how fast the colour fades
    VELOCITY_DISSIPATION: 1.6,  // how fast the flow calms down
    PRESSURE: 0.1,
    PRESSURE_ITERATIONS: 20,
    CURL: 4,                    // swirliness
    SPLAT_RADIUS: 0.28,
    SPLAT_FORCE: 7200,
    SHADING: true,
    COLOR_UPDATE_SPEED: 8,
    COLOR_SCALE: 0.28,          // brightness of the dye a moving cursor leaves behind
    BURST_FORCE: 9000,          // hover on the hero name: how hard the ring is thrown outwards
    BURST_COLOR: 6,             // ...and how bright it is (multiple of COLOR_SCALE). Lower = subtler
    MAX_DPR: 1.5,               // cap canvas resolution; the fluid is soft anyway
    IDLE_MS: 8000               // stop simulating this long after the last movement
  };

  /* ------------------------------------------------------------------------
   * Colour helpers
   * ---------------------------------------------------------------------- */
  function hsvToRgb(h, s, v) {
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: return { r: v, g: t, b: p };
      case 1: return { r: q, g: v, b: p };
      case 2: return { r: p, g: v, b: t };
      case 3: return { r: p, g: q, b: v };
      case 4: return { r: t, g: p, b: v };
      default: return { r: v, g: p, b: q };
    }
  }

  function makeColor(scale) {
    var c = hsvToRgb(Math.random(), 1, 1);
    return { r: c.r * scale, g: c.g * scale, b: c.b * scale };
  }

  /* ------------------------------------------------------------------------
   * The simulation (all GL state lives in this closure so it can be rebuilt
   * after a lost context).
   * ---------------------------------------------------------------------- */
  function createSimulation(canvas, config) {
    var glParams = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: true
    };

    var gl = canvas.getContext('webgl2', glParams);
    var isWebGL2 = !!gl;
    if (!isWebGL2) {
      gl = canvas.getContext('webgl', glParams) || canvas.getContext('experimental-webgl', glParams);
    }
    if (!gl) throw new Error('WebGL is not available');

    var halfFloatType;
    var supportLinear;
    if (isWebGL2) {
      gl.getExtension('EXT_color_buffer_float');
      gl.getExtension('OES_texture_float_linear');
      halfFloatType = gl.HALF_FLOAT;
      supportLinear = true; // 16-bit float textures are filterable in WebGL2
    } else {
      var hf = gl.getExtension('OES_texture_half_float');
      if (!hf) throw new Error('Half-float textures are not supported');
      gl.getExtension('EXT_color_buffer_half_float');
      halfFloatType = hf.HALF_FLOAT_OES;
      supportLinear = !!gl.getExtension('OES_texture_half_float_linear');
    }
    gl.clearColor(0, 0, 0, 0);

    /* ---- texture formats ---- */
    function supportsRenderTexture(internalFormat, format, type) {
      var texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(texture);
      return ok;
    }

    function getSupportedFormat(internalFormat, format, type) {
      if (!supportsRenderTexture(internalFormat, format, type)) {
        if (isWebGL2 && internalFormat === gl.R16F) return getSupportedFormat(gl.RG16F, gl.RG, type);
        if (isWebGL2 && internalFormat === gl.RG16F) return getSupportedFormat(gl.RGBA16F, gl.RGBA, type);
        return null;
      }
      return { internalFormat: internalFormat, format: format };
    }

    var formatRGBA, formatRG, formatR;
    if (isWebGL2) {
      formatRGBA = getSupportedFormat(gl.RGBA16F, gl.RGBA, halfFloatType);
      formatRG = getSupportedFormat(gl.RG16F, gl.RG, halfFloatType);
      formatR = getSupportedFormat(gl.R16F, gl.RED, halfFloatType);
    } else {
      formatRGBA = formatRG = formatR = getSupportedFormat(gl.RGBA, gl.RGBA, halfFloatType);
    }
    if (!formatRGBA || !formatRG || !formatR) {
      throw new Error('Cannot render to half-float textures on this device');
    }

    /* ---- shader helpers ---- */
    function compileShader(type, source, keywords) {
      if (keywords && keywords.length) {
        source = keywords.map(function (k) { return '#define ' + k + '\n'; }).join('') + source;
      }
      var shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(shader));
      }
      return shader;
    }

    function linkProgram(vertexShader, fragmentShader) {
      var program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.bindAttribLocation(program, 0, 'aPosition');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('Program link failed: ' + gl.getProgramInfoLog(program));
      }
      return program;
    }

    function getUniforms(program) {
      var uniforms = {};
      var count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < count; i++) {
        var name = gl.getActiveUniform(program, i).name;
        uniforms[name] = gl.getUniformLocation(program, name);
      }
      return uniforms;
    }

    var baseVertexShader = compileShader(gl.VERTEX_SHADER, [
      'precision highp float;',
      'attribute vec2 aPosition;',
      'varying vec2 vUv;',
      'varying vec2 vL;',
      'varying vec2 vR;',
      'varying vec2 vT;',
      'varying vec2 vB;',
      'uniform vec2 texelSize;',
      'void main () {',
      '  vUv = aPosition * 0.5 + 0.5;',
      '  vL = vUv - vec2(texelSize.x, 0.0);',
      '  vR = vUv + vec2(texelSize.x, 0.0);',
      '  vT = vUv + vec2(0.0, texelSize.y);',
      '  vB = vUv - vec2(0.0, texelSize.y);',
      '  gl_Position = vec4(aPosition, 0.0, 1.0);',
      '}'
    ].join('\n'));

    function makeProgram(fragmentSource, keywords) {
      var program = linkProgram(baseVertexShader, compileShader(gl.FRAGMENT_SHADER, fragmentSource, keywords));
      return {
        program: program,
        uniforms: getUniforms(program),
        bind: function () { gl.useProgram(program); }
      };
    }

    var copyProgram = makeProgram([
      'precision mediump float;',
      'precision mediump sampler2D;',
      'varying highp vec2 vUv;',
      'uniform sampler2D uTexture;',
      'void main () { gl_FragColor = texture2D(uTexture, vUv); }'
    ].join('\n'));

    var clearProgram = makeProgram([
      'precision mediump float;',
      'precision mediump sampler2D;',
      'varying highp vec2 vUv;',
      'uniform sampler2D uTexture;',
      'uniform float value;',
      'void main () { gl_FragColor = value * texture2D(uTexture, vUv); }'
    ].join('\n'));

    var splatProgram = makeProgram([
      'precision highp float;',
      'precision highp sampler2D;',
      'varying vec2 vUv;',
      'uniform sampler2D uTarget;',
      'uniform float aspectRatio;',
      'uniform vec3 color;',
      'uniform vec2 point;',
      'uniform float radius;',
      'void main () {',
      '  vec2 p = vUv - point.xy;',
      '  p.x *= aspectRatio;',
      '  vec3 splat = exp(-dot(p, p) / radius) * color;',
      '  vec3 base = texture2D(uTarget, vUv).xyz;',
      '  gl_FragColor = vec4(base + splat, 1.0);',
      '}'
    ].join('\n'));

    var advectionProgram = makeProgram([
      'precision highp float;',
      'precision highp sampler2D;',
      'varying vec2 vUv;',
      'uniform sampler2D uVelocity;',
      'uniform sampler2D uSource;',
      'uniform vec2 texelSize;',
      'uniform vec2 dyeTexelSize;',
      'uniform float dt;',
      'uniform float dissipation;',
      'vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {',
      '  vec2 st = uv / tsize - 0.5;',
      '  vec2 iuv = floor(st);',
      '  vec2 fuv = fract(st);',
      '  vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);',
      '  vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);',
      '  vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);',
      '  vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);',
      '  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);',
      '}',
      'void main () {',
      '  #ifdef MANUAL_FILTERING',
      '    vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;',
      '    vec4 result = bilerp(uSource, coord, dyeTexelSize);',
      '  #else',
      '    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;',
      '    vec4 result = texture2D(uSource, coord);',
      '  #endif',
      '  float decay = 1.0 + dissipation * dt;',
      '  gl_FragColor = result / decay;',
      '}'
    ].join('\n'), supportLinear ? null : ['MANUAL_FILTERING']);

    var divergenceProgram = makeProgram([
      'precision mediump float;',
      'precision mediump sampler2D;',
      'varying highp vec2 vUv;',
      'varying highp vec2 vL;',
      'varying highp vec2 vR;',
      'varying highp vec2 vT;',
      'varying highp vec2 vB;',
      'uniform sampler2D uVelocity;',
      'void main () {',
      '  float L = texture2D(uVelocity, vL).x;',
      '  float R = texture2D(uVelocity, vR).x;',
      '  float T = texture2D(uVelocity, vT).y;',
      '  float B = texture2D(uVelocity, vB).y;',
      '  vec2 C = texture2D(uVelocity, vUv).xy;',
      '  if (vL.x < 0.0) { L = -C.x; }',
      '  if (vR.x > 1.0) { R = -C.x; }',
      '  if (vT.y > 1.0) { T = -C.y; }',
      '  if (vB.y < 0.0) { B = -C.y; }',
      '  float div = 0.5 * (R - L + T - B);',
      '  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);',
      '}'
    ].join('\n'));

    var curlProgram = makeProgram([
      'precision mediump float;',
      'precision mediump sampler2D;',
      'varying highp vec2 vUv;',
      'varying highp vec2 vL;',
      'varying highp vec2 vR;',
      'varying highp vec2 vT;',
      'varying highp vec2 vB;',
      'uniform sampler2D uVelocity;',
      'void main () {',
      '  float L = texture2D(uVelocity, vL).y;',
      '  float R = texture2D(uVelocity, vR).y;',
      '  float T = texture2D(uVelocity, vT).x;',
      '  float B = texture2D(uVelocity, vB).x;',
      '  float vorticity = R - L - T + B;',
      '  gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);',
      '}'
    ].join('\n'));

    var vorticityProgram = makeProgram([
      'precision highp float;',
      'precision highp sampler2D;',
      'varying vec2 vUv;',
      'varying vec2 vL;',
      'varying vec2 vR;',
      'varying vec2 vT;',
      'varying vec2 vB;',
      'uniform sampler2D uVelocity;',
      'uniform sampler2D uCurl;',
      'uniform float curl;',
      'uniform float dt;',
      'void main () {',
      '  float L = texture2D(uCurl, vL).x;',
      '  float R = texture2D(uCurl, vR).x;',
      '  float T = texture2D(uCurl, vT).x;',
      '  float B = texture2D(uCurl, vB).x;',
      '  float C = texture2D(uCurl, vUv).x;',
      '  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));',
      '  force /= length(force) + 0.0001;',
      '  force *= curl * C;',
      '  force.y *= -1.0;',
      '  vec2 velocity = texture2D(uVelocity, vUv).xy;',
      '  velocity += force * dt;',
      '  velocity = min(max(velocity, -1000.0), 1000.0);',
      '  gl_FragColor = vec4(velocity, 0.0, 1.0);',
      '}'
    ].join('\n'));

    var pressureProgram = makeProgram([
      'precision mediump float;',
      'precision mediump sampler2D;',
      'varying highp vec2 vUv;',
      'varying highp vec2 vL;',
      'varying highp vec2 vR;',
      'varying highp vec2 vT;',
      'varying highp vec2 vB;',
      'uniform sampler2D uPressure;',
      'uniform sampler2D uDivergence;',
      'void main () {',
      '  float L = texture2D(uPressure, vL).x;',
      '  float R = texture2D(uPressure, vR).x;',
      '  float T = texture2D(uPressure, vT).x;',
      '  float B = texture2D(uPressure, vB).x;',
      '  float divergence = texture2D(uDivergence, vUv).x;',
      '  float pressure = (L + R + B + T - divergence) * 0.25;',
      '  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);',
      '}'
    ].join('\n'));

    var gradientSubtractProgram = makeProgram([
      'precision mediump float;',
      'precision mediump sampler2D;',
      'varying highp vec2 vUv;',
      'varying highp vec2 vL;',
      'varying highp vec2 vR;',
      'varying highp vec2 vT;',
      'varying highp vec2 vB;',
      'uniform sampler2D uPressure;',
      'uniform sampler2D uVelocity;',
      'void main () {',
      '  float L = texture2D(uPressure, vL).x;',
      '  float R = texture2D(uPressure, vR).x;',
      '  float T = texture2D(uPressure, vT).x;',
      '  float B = texture2D(uPressure, vB).x;',
      '  vec2 velocity = texture2D(uVelocity, vUv).xy;',
      '  velocity.xy -= vec2(R - L, T - B);',
      '  gl_FragColor = vec4(velocity, 0.0, 1.0);',
      '}'
    ].join('\n'));

    var useShading = config.SHADING && supportLinear;
    var displayProgram = makeProgram([
      'precision highp float;',
      'precision highp sampler2D;',
      'varying vec2 vUv;',
      'varying vec2 vL;',
      'varying vec2 vR;',
      'varying vec2 vT;',
      'varying vec2 vB;',
      'uniform sampler2D uTexture;',
      'uniform vec2 texelSize;',
      'void main () {',
      '  vec3 c = texture2D(uTexture, vUv).rgb;',
      '  #ifdef SHADING',
      '    vec3 lc = texture2D(uTexture, vL).rgb;',
      '    vec3 rc = texture2D(uTexture, vR).rgb;',
      '    vec3 tc = texture2D(uTexture, vT).rgb;',
      '    vec3 bc = texture2D(uTexture, vB).rgb;',
      '    float dx = length(rc) - length(lc);',
      '    float dy = length(tc) - length(bc);',
      '    vec3 n = normalize(vec3(dx, dy, length(texelSize)));',
      '    vec3 l = vec3(0.0, 0.0, 1.0);',
      '    float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);',
      '    c *= diffuse;',
      '  #endif',
      '  float a = max(c.r, max(c.g, c.b));',
      '  gl_FragColor = vec4(c, a);',
      '}'
    ].join('\n'), useShading ? ['SHADING'] : null);

    /* ---- full-screen quad ---- */
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    function blit(target, clear) {
      if (target == null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      if (clear) gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }

    /* ---- framebuffers ---- */
    function createFBO(w, h, internalFormat, format, type, filter) {
      gl.activeTexture(gl.TEXTURE0);
      var texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);

      return {
        texture: texture,
        fbo: fbo,
        width: w,
        height: h,
        texelSizeX: 1 / w,
        texelSizeY: 1 / h,
        attach: function (unit) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          return unit;
        }
      };
    }

    function deleteFBO(fbo) {
      if (!fbo) return;
      gl.deleteTexture(fbo.texture);
      gl.deleteFramebuffer(fbo.fbo);
    }

    function createDoubleFBO(w, h, internalFormat, format, type, filter) {
      var a = createFBO(w, h, internalFormat, format, type, filter);
      var b = createFBO(w, h, internalFormat, format, type, filter);
      return {
        width: w,
        height: h,
        texelSizeX: a.texelSizeX,
        texelSizeY: a.texelSizeY,
        get read() { return a; },
        set read(v) { a = v; },
        get write() { return b; },
        set write(v) { b = v; },
        swap: function () { var t = a; a = b; b = t; }
      };
    }

    function resizeFBO(target, w, h, internalFormat, format, type, filter) {
      var next = createFBO(w, h, internalFormat, format, type, filter);
      copyProgram.bind();
      gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
      blit(next);
      deleteFBO(target);
      return next;
    }

    function resizeDoubleFBO(target, w, h, internalFormat, format, type, filter) {
      if (target.width === w && target.height === h) return target;
      target.read = resizeFBO(target.read, w, h, internalFormat, format, type, filter);
      deleteFBO(target.write);
      target.write = createFBO(w, h, internalFormat, format, type, filter);
      target.width = w;
      target.height = h;
      target.texelSizeX = 1 / w;
      target.texelSizeY = 1 / h;
      return target;
    }

    function getResolution(resolution) {
      var aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
      if (aspect < 1) aspect = 1 / aspect;
      var min = Math.round(resolution);
      var max = Math.round(resolution * aspect);
      return gl.drawingBufferWidth > gl.drawingBufferHeight
        ? { width: max, height: min }
        : { width: min, height: max };
    }

    var dye = null;
    var velocity = null;
    var divergence = null;
    var curl = null;
    var pressure = null;

    function initFramebuffers() {
      var simRes = getResolution(config.SIM_RESOLUTION);
      var dyeRes = getResolution(config.DYE_RESOLUTION);
      var linear = supportLinear ? gl.LINEAR : gl.NEAREST;

      gl.disable(gl.BLEND);

      dye = dye
        ? resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, formatRGBA.internalFormat, formatRGBA.format, halfFloatType, linear)
        : createDoubleFBO(dyeRes.width, dyeRes.height, formatRGBA.internalFormat, formatRGBA.format, halfFloatType, linear);

      velocity = velocity
        ? resizeDoubleFBO(velocity, simRes.width, simRes.height, formatRG.internalFormat, formatRG.format, halfFloatType, linear)
        : createDoubleFBO(simRes.width, simRes.height, formatRG.internalFormat, formatRG.format, halfFloatType, linear);

      // Scratch buffers carry no state between frames, so just recreate them.
      deleteFBO(divergence);
      deleteFBO(curl);
      if (pressure) { deleteFBO(pressure.read); deleteFBO(pressure.write); }
      divergence = createFBO(simRes.width, simRes.height, formatR.internalFormat, formatR.format, halfFloatType, gl.NEAREST);
      curl = createFBO(simRes.width, simRes.height, formatR.internalFormat, formatR.format, halfFloatType, gl.NEAREST);
      pressure = createDoubleFBO(simRes.width, simRes.height, formatR.internalFormat, formatR.format, halfFloatType, gl.NEAREST);
    }

    /* ---- one simulation step ---- */
    function step(dt) {
      gl.disable(gl.BLEND);

      curlProgram.bind();
      gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
      blit(curl);

      vorticityProgram.bind();
      gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
      gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
      gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
      gl.uniform1f(vorticityProgram.uniforms.dt, dt);
      blit(velocity.write);
      velocity.swap();

      divergenceProgram.bind();
      gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
      blit(divergence);

      clearProgram.bind();
      gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
      gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
      blit(pressure.write);
      pressure.swap();

      pressureProgram.bind();
      gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
      for (var i = 0; i < config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
        blit(pressure.write);
        pressure.swap();
      }

      gradientSubtractProgram.bind();
      gl.uniform2f(gradientSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
      gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
      blit(velocity.write);
      velocity.swap();

      // move the velocity field along itself...
      advectionProgram.bind();
      gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      if (!supportLinear) {
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
      }
      var velocityId = velocity.read.attach(0);
      gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
      gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
      gl.uniform1f(advectionProgram.uniforms.dt, dt);
      gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
      blit(velocity.write);
      velocity.swap();

      // ...then carry the dye with it.
      if (!supportLinear) {
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
      }
      gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
      gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
      gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
      blit(dye.write);
      dye.swap();
    }

    /* ---- draw the dye to the screen (transparent canvas) ---- */
    function render() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.BLEND);
      displayProgram.bind();
      gl.uniform2f(displayProgram.uniforms.texelSize, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
      gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
      blit(null);
    }

    /* ---- add force + colour at a point (x, y in 0..1, origin bottom-left) ---- */
    function correctRadius(radius) {
      var aspect = canvas.width / canvas.height;
      return aspect > 1 ? radius * aspect : radius;
    }

    function splat(x, y, dx, dy, color) {
      gl.disable(gl.BLEND);
      splatProgram.bind();
      gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
      gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
      gl.uniform2f(splatProgram.uniforms.point, x, y);
      gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0);
      gl.uniform1f(splatProgram.uniforms.radius, correctRadius(config.SPLAT_RADIUS / 100));
      blit(velocity.write);
      velocity.swap();

      gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
      gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
      blit(dye.write);
      dye.swap();
    }

    initFramebuffers();

    return { resize: initFramebuffers, step: step, render: render, splat: splat };
  }

  /* ------------------------------------------------------------------------
   * Controller: canvas sizing, input, and the (single) animation loop
   * ---------------------------------------------------------------------- */
  var sim = null;
  var running = false;
  var rafId = 0;
  var lastTime = 0;
  var lastActive = 0;
  var colorTimer = 0;
  var lastBurst = 0;

  var pointer = {
    x: 0, y: 0,          // last position, 0..1, origin bottom-left
    dx: 0, dy: 0,        // movement accumulated since the last frame
    active: false,       // false until we know where the pointer is (avoids a big jump)
    moved: false,
    color: makeColor(CONFIG.COLOR_SCALE)
  };

  function syncCanvasSize() {
    var dpr = Math.min(window.devicePixelRatio || 1, CONFIG.MAX_DPR);
    var w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    var h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    return true;
  }

  function boot() {
    try {
      syncCanvasSize();
      sim = createSimulation(canvas, CONFIG);
      canvas.style.display = '';
      return true;
    } catch (err) {
      console.warn('[fluid] background disabled:', err && err.message ? err.message : err);
      sim = null;
      canvas.style.display = 'none';
      return false;
    }
  }

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    var dt = Math.min(Math.max((now - lastTime) / 1000, 0), 1 / 60);
    lastTime = now;

    if (syncCanvasSize()) sim.resize();

    // pick a new colour for the cursor trail every so often
    colorTimer += dt * CONFIG.COLOR_UPDATE_SPEED;
    if (colorTimer >= 1) {
      colorTimer %= 1;
      pointer.color = makeColor(CONFIG.COLOR_SCALE);
    }

    if (pointer.moved) {
      pointer.moved = false;
      sim.splat(pointer.x, pointer.y, pointer.dx * CONFIG.SPLAT_FORCE, pointer.dy * CONFIG.SPLAT_FORCE, pointer.color);
      pointer.dx = 0;
      pointer.dy = 0;
    }

    sim.step(dt);
    sim.render();

    if (now - lastActive > CONFIG.IDLE_MS) stop();
  }

  function wake() {
    lastActive = performance.now();
    if (running || !sim) return;
    running = true;
    lastTime = lastActive;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  function aspectRatio() { return canvas.width / canvas.height; }
  function correctDeltaX(d) { var a = aspectRatio(); return a < 1 ? d * a : d; }
  function correctDeltaY(d) { var a = aspectRatio(); return a > 1 ? d / a : d; }

  function onMove(clientX, clientY) {
    if (!sim) return;
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    var x = clientX / w;
    var y = 1 - clientY / h;
    if (pointer.active) {
      var dx = correctDeltaX(x - pointer.x);
      var dy = correctDeltaY(y - pointer.y);
      if (dx !== 0 || dy !== 0) {
        pointer.dx += dx;
        pointer.dy += dy;
        pointer.moved = true;
      }
    }
    pointer.x = x;
    pointer.y = y;
    pointer.active = true;
    wake();
  }

  window.addEventListener('mousemove', function (e) { onMove(e.clientX, e.clientY); }, { passive: true });

  window.addEventListener('mousedown', function (e) {
    if (!sim) return;
    onMove(e.clientX, e.clientY);
    // a click drops a bright blob of colour
    sim.splat(
      pointer.x, pointer.y,
      10 * (Math.random() - 0.5), 30 * (Math.random() - 0.5),
      makeColor(CONFIG.COLOR_SCALE * 10)
    );
    wake();
  }, { passive: true });

  window.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    if (!t) return;
    pointer.active = false; // start a fresh stroke, no jump from the previous touch
    onMove(t.clientX, t.clientY);
  }, { passive: true });

  window.addEventListener('touchmove', function (e) {
    var t = e.touches[0];
    if (t) onMove(t.clientX, t.clientY);
  }, { passive: true });

  window.addEventListener('touchend', function () { pointer.active = false; }, { passive: true });
  window.addEventListener('blur', function () { pointer.active = false; });
  document.documentElement.addEventListener('mouseleave', function () { pointer.active = false; });

  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    stop();
    sim = null;
  });
  canvas.addEventListener('webglcontextrestored', function () {
    if (boot()) wake();
  });

  /* ---- public helpers ---- */

  // A ring of colour thrown outwards from a DOM rect (used when hovering the hero name).
  function burst(rect) {
    if (!sim || reduceMotion || !rect) return;
    var now = performance.now();
    if (now - lastBurst < 160) return; // throttle
    lastBurst = now;

    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var rx = rect.width / 2;
    var ry = rect.height / 2;
    var count = 18;

    for (var i = 0; i < count; i++) {
      var angle = (i / count) * Math.PI * 2 + Math.random() * 0.2;
      var px = cx + Math.cos(angle) * (rx + 6);
      var py = cy + Math.sin(angle) * (ry + 6);
      sim.splat(px / w, 1 - py / h, Math.cos(angle) * CONFIG.BURST_FORCE, -Math.sin(angle) * CONFIG.BURST_FORCE, makeColor(CONFIG.COLOR_SCALE * CONFIG.BURST_COLOR));
    }
    wake();
  }

  // A few soft splashes shortly after load, so it's obvious the background is alive.
  function intro() {
    if (!sim || reduceMotion) return;
    for (var i = 0; i < 4; i++) {
      sim.splat(
        0.2 + Math.random() * 0.6,
        0.5 + Math.random() * 0.3,
        (Math.random() - 0.5) * 700,
        (Math.random() - 0.5) * 700,
        makeColor(CONFIG.COLOR_SCALE * 1.6)
      );
    }
    wake();
  }

  window.Fluid = {
    enabled: false,
    burst: burst,
    splat: function (x, y, dx, dy, color) {
      if (!sim) return;
      sim.splat(x, y, dx, dy, color || makeColor(CONFIG.COLOR_SCALE));
      wake();
    }
  };

  if (boot()) {
    window.Fluid.enabled = true;
    setTimeout(intro, 500);
  }
})();
