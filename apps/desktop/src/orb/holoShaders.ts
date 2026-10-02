// GLSL for the holographic Orb. Everything is emissive light (HDR linear); the composite tone-maps once.
// Orb units: 1.0 = the O's outer radius.

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}`

/** Flat quad in the object's plane spanning uSize orb units; vP is in orb units. */
const PLANE_VERT = /* glsl */ `
uniform float uSize;
varying vec2 vP;
void main() {
  vP = position.xy * uSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy * uSize, 0.0, 1.0);
}`

/**
 * Universal holographic ring on an annulus mesh (aU = angle 0..1, aV = across width 0..1).
 * Modes: 0 solid band · 1 dashes · 2 ticks (major every uMajor) · 3 segmented arcs.
 * A highlight travels around the ring; uReveal draws the ring on angularly with a hot leading edge.
 */
export const ring = {
  vertex: /* glsl */ `
attribute float aU; attribute float aV;
varying float vU; varying float vV;
void main() { vU = aU; vV = aV; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragment: /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uIntensity; uniform int uMode; uniform float uCount; uniform float uDuty;
uniform float uMajor; uniform float uReveal; uniform float uHl; uniform float uHlWidth; uniform float uHlGain;
uniform float uFlicker; uniform float uTime; uniform float uCore;
varying float vU; varying float vV;
float aa(float x, float w) { return smoothstep(0.0, w, x); }
void main() {
  if (vU > uReveal) discard;
  float w = fwidth(vU) * 1.5;
  float m = 1.0;
  if (uMode == 1) {
    float f = fract(vU * uCount);
    m = aa(f, w * uCount) * aa(uDuty - f, w * uCount);
  } else if (uMode == 2) {
    float f = fract(vU * uCount);
    float idx = floor(vU * uCount);
    bool major = mod(idx, uMajor) < 0.5;
    float len = major ? 1.0 : 0.45;
    m = aa(f, w * uCount) * aa(uDuty - f, w * uCount) * step(1.0 - len, vV) * (major ? 1.6 : 0.8);
  } else if (uMode == 3) {
    float f = fract(vU * uCount);
    m = aa(f - 0.02, w * uCount) * aa(uDuty - f, w * uCount);
  }
  // Crisp band: 1-pixel anti-aliased edges (fwidth), flat interior, plus an optional hot centre line.
  float wv = fwidth(vV) * 1.2;
  float across = smoothstep(0.0, wv, vV) * smoothstep(1.0, 1.0 - wv, vV);
  float core = smoothstep(0.5 - 0.12 - wv, 0.5 - 0.12, vV) * smoothstep(0.5 + 0.12 + wv, 0.5 + 0.12, vV) * uCore;
  float d = abs(fract(vU - uHl + 0.5) - 0.5);
  float hl = exp(-d * d / (uHlWidth * uHlWidth)) * uHlGain;
  float head = smoothstep(uReveal - 0.04, uReveal, vU) * step(uReveal, 0.999) * 4.0;
  float flick = 1.0 - uFlicker * (0.5 + 0.5 * sin(uTime * 37.0 + vU * 80.0)) * 0.35;
  float e = m * (across + core) * (1.0 + hl) * flick + head * across;
  gl_FragColor = vec4(uColor * e * uIntensity, 1.0);
}`,
}

/** Ribbon along a polyline (aS = arc length 0..1, aSide −1/+1): glowing edge with light pulses travelling along it. */
export const ribbon = {
  vertex: /* glsl */ `
attribute float aS; attribute float aSide;
varying float vS; varying float vSide;
void main() { vS = aS; vSide = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragment: /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uIntensity; uniform float uReveal; uniform float uPulse; uniform float uPulsePos;
uniform float uTime;
varying float vS; varying float vSide;
void main() {
  if (vS > uReveal) discard;
  float ws = fwidth(vSide) * 1.2;
  float across = smoothstep(1.0, 1.0 - ws, abs(vSide)) * (0.75 + 0.5 * smoothstep(0.45, 0.0, abs(vSide)));
  float head = smoothstep(uReveal - 0.03, uReveal, vS) * step(uReveal, 0.999) * 6.0;
  float p1 = exp(-pow(fract(vS - uPulsePos + 0.5) - 0.5, 2.0) * 1400.0);
  float p2 = exp(-pow(fract(vS - uPulsePos * 0.7 + 0.13 + 0.5) - 0.5, 2.0) * 2600.0) * 0.6;
  float shimmer = 0.85 + 0.15 * sin(vS * 160.0 - uTime * 3.0);
  float e = across * (shimmer + (p1 + p2) * uPulse * 5.0) + head;
  gl_FragColor = vec4(uColor * e * uIntensity, 1.0);
}`,
}

/** Hologram fill for the A/P plates: scanlines, a slow scan band and a faint hex lattice. */
export const holoFill = {
  vertex: /* glsl */ `
varying vec2 vP;
void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragment: /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uIntensity; uniform float uTime; uniform float uScanPos;
varying vec2 vP;
float hexEdge(vec2 p) {
  p *= 9.0;
  vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 a = mod(p, r) - h;
  vec2 b = mod(p - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  vec2 q = abs(g);
  float d = max(dot(q, normalize(vec2(1.0, 1.7320508))), q.x);
  return smoothstep(0.44, 0.5, d);
}
void main() {
  float lines = 0.7 + 0.3 * step(0.5, fract(vP.y * 90.0 - uTime * 0.4));
  float band = exp(-pow(vP.y - uScanPos, 2.0) * 40.0) * 2.2;
  float hex = hexEdge(vP) * 0.6;
  float e = (0.18 * lines + hex * 0.35 + band) ;
  gl_FragColor = vec4(uColor * e * uIntensity, 1.0);
}`,
}

/**
 * Arc-reactor core inside the O: white-hot nucleus, swirling plasma, god rays, and a speech flash.
 * uFlash is the JARVIS voice envelope (fast attack); every syllable visibly brightens the core.
 */
export const core = {
  vertex: PLANE_VERT,
  fragment: /* glsl */ `
precision highp float;
uniform float uTime; uniform float uIntensity; uniform float uFlash; uniform float uIgnite; uniform float uPoint;
uniform float uSwirl; uniform float uInner; uniform vec3 uColor; uniform float uLow;
varying vec2 vP;
${NOISE}
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float a = atan(vP.y, vP.x);
  float t = uTime;
  float flash = uFlash + uIgnite;
  // Swirling plasma (domain-warped, rotating) confined inside the O's inner radius.
  float sw = a + t * uSwirl + r * 4.0;
  vec2 q = vec2(cos(sw), sin(sw)) * r * 3.2;
  float warp = fbm(q + t * 0.15);
  float plasma = fbm(q * 1.7 + warp * 2.2 - t * 0.4);
  float disk = smoothstep(uInner + 0.02, uInner - 0.08, r);
  float plasmaE = pow(plasma, 2.6) * 0.9 * disk * (0.5 + 0.25 * flash);
  // God rays from the nucleus.
  float rays = pow(noise(vec2(a * 18.0, t * 0.6)), 8.0) * exp(-r * 3.2) * (0.4 + 1.6 * flash) * disk;
  float rays2 = pow(abs(sin(a * 12.0 + t * 0.4)), 40.0) * exp(-r * 4.0) * 0.35 * disk;
  // Nucleus.
  float breath = 1.0 + uLow * 0.3 + flash * 0.45;
  float pin = exp(-r * r * 2600.0 / breath) * 30.0;
  float hot = exp(-r * r * 500.0 / breath) * (3.0 + flash * 1.4);
  float glow = exp(-r * r * 90.0 / breath) * 0.35 * (1.0 + flash * 0.3);
  // Inner rim of the O lights up from inside.
  float rim = exp(-pow((r - uInner) / 0.008, 2.0)) * (0.9 + 1.6 * flash) + exp(-pow((r - uInner) / 0.05, 2.0)) * 0.15 * (1.0 + flash);
  vec3 cool = uColor;
  vec3 col = vec3(1.0) * (pin + hot) + mix(cool, vec3(1.0), 0.25) * (glow + rays) + cool * (plasmaE + rays2) + mix(cool, vec3(1.0), 0.4) * rim;
  col *= uIntensity;
  col += vec3(1.0) * exp(-r * r * 4000.0) * uPoint * 60.0;
  col *= smoothstep(1.0, 0.85, r);
  gl_FragColor = vec4(col, 1.0);
}`,
}

/** Expanding shockwave ring emitted on speech onsets (and boot flare). */
export const shock = {
  vertex: PLANE_VERT,
  fragment: /* glsl */ `
precision highp float;
uniform float uRadius; uniform float uAlpha; uniform float uWidth; uniform vec3 uColor;
varying vec2 vP;
void main() {
  float r = length(vP);
  float d = (r - uRadius) / uWidth;
  float e = exp(-d * d) * 1.8;
  gl_FragColor = vec4(uColor * e * uAlpha, 1.0);
}`,
}

/** Radar sweep: a rotating wedge with a sharp leading edge and a long trailing falloff. */
export const sweep = {
  vertex: PLANE_VERT,
  fragment: /* glsl */ `
precision highp float;
uniform float uAngle; uniform float uIntensity; uniform float uR0; uniform float uR1; uniform vec3 uColor;
varying vec2 vP;
void main() {
  float r = length(vP);
  if (r < uR0 || r > uR1) discard;
  float a = atan(vP.y, vP.x);
  float d = mod(uAngle - a, 6.2831853);
  float trail = exp(-d * 3.5) * 0.35 + exp(-d * 60.0) * 2.4;
  float edge = smoothstep(uR0, uR0 + 0.05, r) * smoothstep(uR1, uR1 - 0.15, r);
  float rings = 0.35 + 0.65 * smoothstep(0.4, 0.5, fract(r * 26.0)) * smoothstep(0.6, 0.5, fract(r * 26.0));
  gl_FragColor = vec4(uColor * trail * edge * rings * uIntensity, 1.0);
}`,
}

/** Sparks: orbiting light motes; uBurst pushes them outward on speech, then they drift back. */
export const sparks = {
  vertex: /* glsl */ `
attribute float aSeed; attribute float aRadius; attribute float aAngle; attribute float aSpeed; attribute float aZ;
uniform float uTime; uniform float uBurst; uniform float uPull; uniform float uSize; uniform float uPixelRatio; uniform float uViewH;
uniform float uDensity;
varying float vAlpha; varying float vSeed;
void main() {
  float ang = aAngle + uTime * aSpeed;
  float r = aRadius * (1.0 + uBurst * (0.25 + aSeed * 0.5)) * (1.0 - uPull * 0.18 * (0.5 + 0.5 * sin(uTime * 3.0 + aSeed * 30.0)));
  vec3 pos = vec3(cos(ang) * r, sin(ang) * r, aZ);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  vAlpha = step(aSeed, uDensity);
  vSeed = aSeed;
  gl_PointSize = uSize * (0.4 + aSeed * 1.2) * uPixelRatio * uViewH / (-mv.z * 900.0);
}`,
  fragment: /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uAlpha; uniform float uTime;
varying float vAlpha; varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float disc = exp(-d * d * 9.0) + exp(-d * d * 60.0) * 2.0;
  float twinkle = 0.55 + 0.45 * sin(uTime * (1.2 + vSeed * 3.0) + vSeed * 50.0);
  gl_FragColor = vec4(uColor * disc * uAlpha * vAlpha * twinkle, 1.0);
}`,
}
