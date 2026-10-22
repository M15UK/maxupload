// GPU enhancer (WebGL2): contrast-adaptive sharpening, an HDR look (local tone mapping), a gentle
// S-curve and vibrance.
// It runs on every frame after resizing, so it sharpens exactly the pixels TikTok receives.
// This is classic image processing, not generative AI: it makes existing detail crisper and
// colors richer, but it cannot invent detail that was never recorded.
import { AppError } from './app-error.js';

/** @typedef {import('./encode-plan.js').EnhanceParams} EnhanceParams */

// The HDR look measures brightness over areas about 1/24 of the short side (90 px on 4K).
const HDR_AREAS_PER_SHORT_SIDE = 24;

const VERTEX_SHADER = `#version 300 es
out vec2 vUv;
void main() {
  // One triangle covering the screen. The y flip keeps the image's top row at the top of the canvas.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = vec2(corner.x, 1.0 - corner.y);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uTexel;
uniform float uSharpness;
uniform float uVibrance;
uniform float uContrast;
uniform float uRadius;
uniform float uHdr;
uniform float uHdrLod;
in vec2 vUv;
out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
// How much of the vibrance boost skin tones are spared (1.0 = fully protected).
const float SKIN_PROTECTION = 0.85;
// HDR look at full strength: how far shadows rise, highlights fall and local contrast grows.
const float HDR_SHADOW_LIFT = 0.18;
const float HDR_HIGHLIGHT_PULL = 0.12;
const float HDR_LOCAL_CONTRAST = 0.3;
// Brightness can at most double (so lifted shadows don't turn noise into grain) and drop by 20%
// (so dark areas next to bright ones don't get a dark halo).
const float HDR_MAX_GAIN = 2.0;
const float HDR_MIN_GAIN = 0.8;

vec3 tap(vec2 offset) {
  return textureLod(uImage, vUv + offset * uRadius * uTexel, 0.0).rgb;
}

// 1.0 for skin-like colors: red >= green >= blue with an orange hue (roughly 5–45 degrees).
float skinWeight(vec3 c) {
  float range = c.r - c.b;
  float ordered = step(c.g, c.r) * step(c.b, c.g) * smoothstep(0.02, 0.06, range);
  float hue = (c.g - c.b) / max(range, 1e-4); // 0 = red, 1 = yellow
  return ordered * smoothstep(0.05, 0.2, hue) * (1.0 - smoothstep(0.65, 0.85, hue));
}

void main() {
  vec3 north = tap(vec2(0.0, -1.0));
  vec3 west = tap(vec2(-1.0, 0.0));
  vec3 center = tap(vec2(0.0));
  vec3 east = tap(vec2(1.0, 0.0));
  vec3 south = tap(vec2(0.0, 1.0));

  // Contrast-adaptive sharpening: sharpen less where local contrast is already high, which avoids halos.
  vec3 lo = min(center, min(min(north, south), min(west, east)));
  vec3 hi = max(center, max(max(north, south), max(west, east)));
  vec3 amount = sqrt(clamp(min(lo, 1.0 - hi) / max(hi, vec3(1e-4)), 0.0, 1.0));
  vec3 weight = amount * (-1.0 / mix(8.0, 5.0, uSharpness));
  vec3 color = clamp((center + (north + south + west + east) * weight) / (1.0 + 4.0 * weight), 0.0, 1.0);

  // HDR look: compare each pixel with the average brightness around it (a small mip level), lift
  // dark areas, hold back bright ones and add local contrast, like a merged HDR photo.
  float surround = dot(textureLod(uImage, vUv, uHdrLod).rgb, LUMA);
  float lum = dot(color, LUMA);
  float tone = (1.0 - smoothstep(0.0, 0.5, surround)) * HDR_SHADOW_LIFT - smoothstep(0.55, 1.0, surround) * HDR_HIGHLIGHT_PULL;
  float target = lum + uHdr * (tone + HDR_LOCAL_CONTRAST * (lum - surround));
  color = clamp(color * clamp(target / max(lum, 1e-3), HDR_MIN_GAIN, HDR_MAX_GAIN), 0.0, 1.0);

  // Gentle S-curve for punch.
  color = mix(color, color * color * (3.0 - 2.0 * color), uContrast);

  // Vibrance: lifts muted colors more than saturated ones, and spares skin tones, which
  // otherwise turn orange once TikTok re-encodes the video and phones display it.
  float luma = dot(color, LUMA);
  float saturation = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
  float boost = uVibrance * (1.0 - saturation) * (1.0 - SKIN_PROTECTION * skinWeight(color));
  color = mix(vec3(luma), color, 1.0 + boost);

  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Enhancer shader failed to compile: ${log}`);
  }
  return shader;
}

function createProgram(gl) {
  const program = gl.createProgram();
  const shaders = [
    compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER),
    compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER),
  ];
  shaders.forEach((shader) => gl.attachShader(program, shader));
  gl.linkProgram(program);
  shaders.forEach((shader) => gl.deleteShader(shader));
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Enhancer shader failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

function createFrameTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // The output is the same size as the input, so each pixel maps to exactly one texel (level 0 is
  // read with NEAREST). Mipmaps give the HDR look each pixel's surrounding brightness.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function setUniforms(gl, program, { width, height, params }) {
  const location = (name) => gl.getUniformLocation(program, name);
  gl.uniform1i(location('uImage'), 0);
  gl.uniform2f(location('uTexel'), 1 / width, 1 / height);
  gl.uniform1f(location('uSharpness'), params.sharpness);
  gl.uniform1f(location('uVibrance'), params.vibrance);
  gl.uniform1f(location('uContrast'), params.contrast);
  gl.uniform1f(location('uRadius'), params.radius);
  gl.uniform1f(location('uHdr'), params.hdr);
  gl.uniform1f(location('uHdrLod'), Math.log2(Math.min(width, height) / HDR_AREAS_PER_SHORT_SIDE));
}

/**
 * Creates a per-frame processor for Mediabunny's `video.process` hook.
 * The returned canvas is reused for every frame; Mediabunny copies it into a VideoFrame immediately.
 * @param {{ width: number, height: number, params: EnhanceParams }} options
 * @returns {{ process: (sample: { toCanvasImageSource(): TexImageSource }) => OffscreenCanvas, dispose: () => void }}
 */
export function createEnhancer({ width, height, params }) {
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new AppError('enhancerUnavailable');

  let program;
  let texture;
  try {
    program = createProgram(gl);
    texture = createFrameTexture(gl);
    gl.useProgram(program);
    gl.bindVertexArray(gl.createVertexArray());
    gl.viewport(0, 0, width, height);
    setUniforms(gl, program, { width, height, params });
  } catch (error) {
    // Driver-specific shader failures: log the details, release the GPU context, show the user a clear fix.
    console.error('Enhancer setup failed.', error);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    throw new AppError('enhancerUnavailable');
  }

  function process(sample) {
    if (gl.isContextLost()) throw new AppError('enhancerUnavailable');
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sample.toCanvasImageSource());
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return canvas;
  }

  function dispose() {
    gl.deleteTexture(texture);
    gl.deleteProgram(program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  return { process, dispose };
}
