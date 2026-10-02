// GLSL for the AOP Orb. All coordinates are "orb units": 1.0 = the O's outer radius.

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}`

export const fullscreenVert = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`

/** Near-black field: soft radial lift, vignette, animated grain, faint state-tinted haze. */
export const backgroundFrag = /* glsl */ `
precision highp float;
uniform vec2 uRes; uniform float uScale; uniform float uTime; uniform vec3 uTint; uniform float uIntensity;
${NOISE}
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uScale;
  float r = length(p);
  vec3 col = mix(vec3(0.003, 0.004, 0.006), vec3(0.010, 0.013, 0.018), exp(-r * 0.7));
  col += uTint * 0.010 * exp(-r * r * 0.35) * uIntensity;
  vec2 q = gl_FragCoord.xy / uRes - 0.5;
  col *= 1.0 - dot(q, q) * 1.1;
  col += (hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) * 0.006;
  gl_FragColor = vec4(col, 1.0);
}`

/** The optical core: glow, glass body, lens rims with minimal chromatic split, scan sweep, rays, flare, voice distortion. */
export const coreFrag = /* glsl */ `
precision highp float;
uniform vec2 uRes; uniform float uScale; uniform float uTime;
uniform float uIntensity; uniform float uCore; uniform float uPulse; uniform float uPoint; uniform float uRing;
uniform float uScan; uniform float uScanAngle; uniform float uFlare; uniform float uDistort; uniform float uInner;
uniform vec3 uTint;
${NOISE}
float band(float r, float c, float w) { float d = (r - c) / w; return exp(-d * d); }
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uScale;
  float r = length(p);
  float a = atan(p.y, p.x);
  float n = noise(vec2(a * 2.5 + uTime * 0.15, r * 3.0 - uTime * 0.5));
  float rd = r + (n - 0.5) * uDistort * 0.05;

  float core = exp(-rd * rd / (0.012 + 0.05 * uCore + 0.04 * uPulse)) * (0.18 + 0.4 * uCore + 0.35 * uPulse);
  float hot = exp(-r * r / (0.0015 + 0.008 * uPulse)) * (0.25 + 0.35 * uPulse);
  float point = exp(-r * r / 0.0006) * uPoint;

  float rim = band(rd, 1.0, 0.0055) * 0.85 + band(rd, 1.0, 0.06) * 0.10;
  float rimIn = band(rd, uInner, 0.0045) * 0.55 + band(rd, uInner, 0.035) * 0.06;
  float t = clamp((r - uInner) / (1.0 - uInner), 0.0, 1.0);
  float body = step(uInner, r) * step(r, 1.0) * (0.025 + 0.09 * pow(t, 4.0) + 0.05 * pow(1.0 - t, 6.0));
  float caustic = body * noise(vec2(a * 6.0, uTime * 0.2)) * 0.6;

  float da = mod(a - uScanAngle, 6.2831853);
  float scan = exp(-da * 2.2) * smoothstep(1.02, 0.25, r) * smoothstep(0.04, 0.3, r) * uScan;

  float rays = pow(abs(sin(a * 30.0 + uTime * 0.05)), 60.0) * exp(-r * 2.2) * 0.12;

  float flare = uFlare * (exp(-abs(p.y) * 70.0) * exp(-abs(p.x) * 0.9) * 0.9 + exp(-r * r * 2.5) * 0.45);

  vec3 col = uTint * (core * 0.8 + (rim + rimIn + body + caustic) * uRing + scan * 0.32 + rays * uRing);
  col += vec3(1.0) * (hot * 0.5 + point + flare);
  col.r += band(rd, 1.006, 0.006) * 0.07 * uRing;
  col.b += band(rd, 0.994, 0.006) * 0.09 * uRing;
  gl_FragColor = vec4(col * uIntensity, 1.0);
}`

/** Thin optical lines with draw-on progress (aDist ∈ [0,1] along each path) and per-vertex alpha. */
export const lineVert = /* glsl */ `
attribute float aDist; attribute float aAlpha;
varying float vDist; varying float vAlpha;
void main() { vDist = aDist; vAlpha = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`

export const lineFrag = /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uAlpha; uniform float uProgress;
varying float vDist; varying float vAlpha;
void main() {
  if (vDist > uProgress) discard;
  float head = smoothstep(uProgress - 0.04, uProgress, vDist) * step(uProgress, 0.999);
  gl_FragColor = vec4(uColor * (1.0 + head * 2.0), uAlpha * vAlpha);
}`

export const particleVert = /* glsl */ `
attribute float aSeed; attribute float aRadius; attribute float aAngle; attribute float aSpeed;
uniform float uTime; uniform float uSpeed; uniform float uPull; uniform float uSize; uniform float uPixelRatio; uniform float uScale;
varying float vSeed;
void main() {
  float ang = aAngle + uTime * aSpeed * uSpeed;
  float r = aRadius * (1.0 - uPull * 0.22 * (0.5 + 0.5 * sin(uTime * 3.0 + aSeed * 40.0)));
  vec3 pos = vec3(cos(ang) * r, sin(ang) * r * (0.92 + 0.08 * aSeed), 0.0);
  vSeed = aSeed;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos * uScale, 1.0);
  gl_PointSize = uSize * (0.6 + aSeed) * uPixelRatio;
}`

export const particleFrag = /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uAlpha; uniform float uTime;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float twinkle = 0.55 + 0.45 * sin(uTime * (1.0 + vSeed * 3.0) + vSeed * 50.0);
  gl_FragColor = vec4(uColor, (1.0 - d) * uAlpha * twinkle * step(d, 1.0));
}`

/** Agent orbit nodes: per-node intensity + pulse. */
export const nodeVert = /* glsl */ `
attribute float aIntensity; attribute float aPulse;
uniform float uTime; uniform float uPixelRatio; uniform float uSize;
varying float vIntensity;
void main() {
  float beat = 1.0 + aPulse * 0.35 * sin(uTime * 4.0);
  vIntensity = aIntensity;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize * beat * uPixelRatio * (0.5 + aIntensity);
}`

export const nodeFrag = /* glsl */ `
precision highp float;
uniform vec3 uColor;
varying float vIntensity;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float ring = smoothstep(0.08, 0.0, abs(d - 0.62)) * 0.9;
  float dot_ = smoothstep(0.32, 0.0, d);
  float halo = exp(-d * d * 6.0) * 0.35;
  gl_FragColor = vec4(uColor, (ring + dot_ + halo) * vIntensity * step(d, 1.0));
}`
