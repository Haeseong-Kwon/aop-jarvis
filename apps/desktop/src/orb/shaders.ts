// GLSL for the AOP Orb. Emissive shaders write HDR linear values; the composite pass tone-maps once.
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
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}`

/** Camera-facing quad (billboard) centred on the object origin; `position.xy` spans [-0.5, 0.5]. */
const BILLBOARD_VERT = /* glsl */ `
uniform float uSize;
varying vec2 vP;
void main() {
  vP = position.xy * 2.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}`

/**
 * Energy nucleus: white-hot point → blue-white plasma → layered corona → transparent halo.
 * Turbulence is slow, low-amplitude domain-warped fbm in polar space: controlled, engineered — not fire.
 */
export const nucleus = {
  vertex: BILLBOARD_VERT,
  fragment: /* glsl */ `
precision highp float;
uniform float uTime; uniform float uIntensity; uniform float uLow; uniform float uIgnite; uniform float uPoint;
uniform vec3 uColor;
varying vec2 vP;
${NOISE}
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float a = atan(vP.y, vP.x);
  float t = uTime;
  vec2 polar = vec2(a * 1.5915, r);
  float warp = fbm(vec2(a * 2.0 + t * 0.07, r * 3.0 - t * 0.21));
  float turb = fbm(vec2(a * 3.0 + warp * 1.6 - t * 0.05, r * 7.0 - t * 0.45 + warp));
  float breath = 1.0 + uLow * 0.55;

  float pin = exp(-r * r * 900.0 / breath) * 40.0;
  float hot = exp(-r * r * 160.0 / breath) * 6.0;
  float plasma = exp(-r * r * 60.0 / breath) * (0.7 + 0.6 * turb) * 1.5;
  float corona = exp(-r * 5.2) * smoothstep(0.38, 0.85, turb) * 0.9;
  float shell = exp(-pow((r - 0.24 * breath) / 0.05, 2.0)) * (0.25 + 0.4 * warp) * 0.6;
  float halo = exp(-r * 4.2) * 0.12;

  vec3 ice = uColor;
  vec3 col = vec3(1.0) * (pin + hot) + mix(ice, vec3(1.0), 0.45) * plasma + ice * (corona + shell + halo);
  col *= uIntensity * (1.0 + uIgnite * 1.6);
  col += vec3(1.0) * exp(-r * r * 3000.0) * uPoint * 40.0;
  col *= smoothstep(1.0, 0.7, r);
  gl_FragColor = vec4(col, 1.0);
}`,
}

/** Soft additive glow sprite (core glare in front of the dome, ghosts, near bokeh). */
export const glow = {
  vertex: BILLBOARD_VERT,
  fragment: /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uIntensity; uniform float uFalloff; uniform float uRing;
varying vec2 vP;
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float g = exp(-r * r * uFalloff);
  // uRing > 0 turns the sprite into a thin annulus (internal lens reflection ghost).
  g = mix(g, exp(-pow((r - 0.72) / 0.09, 2.0)) * 0.6 + exp(-r * r * 6.0) * 0.1, uRing);
  gl_FragColor = vec4(uColor * g * uIntensity * smoothstep(1.0, 0.85, r), 1.0);
}`,
}

/**
 * Energy transport ring (thin torus). Pulses travel along the angle; direction encodes who is talking:
 * user → inward (cyan), JARVIS → outward (white-blue). uFlow > 0 = outward-moving bright bands.
 */
export const energyRing = {
  vertex: /* glsl */ `
varying vec3 vPos;
void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragment: /* glsl */ `
precision highp float;
uniform float uTime; uniform float uLevel; uniform float uBase; uniform float uPhase; uniform float uReveal; uniform float uHigh;
uniform vec3 uColor; uniform float uSegments;
varying vec3 vPos;
void main() {
  float a = atan(vPos.y, vPos.x) / 6.2831853 + 0.5;
  if (a > uReveal) discard;
  float bands = pow(0.5 + 0.5 * sin((a * uSegments + uPhase) * 6.2831853), 6.0);
  float fine = 0.5 + 0.5 * sin(a * 6.2831853 * 90.0 + uTime * 0.7);
  float e = uBase * (0.55 + 0.45 * fine) + bands * uLevel * 2.2 + uHigh * fine * 1.4;
  gl_FragColor = vec4(uColor * e, 1.0);
}`,
}

/** Inlay light strips on A and P. A pulse can travel along the A → O → P path (aS = 0 → 1). */
export const strip = {
  vertex: /* glsl */ `
attribute float aS;
varying float vS;
void main() { vS = aS; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragment: /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uBase; uniform float uReveal; uniform float uPulse; uniform float uPulsePos;
varying float vS;
void main() {
  if (vS > uReveal) discard;
  float head = smoothstep(uReveal - 0.05, uReveal, vS) * step(uReveal, 0.999) * 3.0;
  float d = vS - uPulsePos;
  float pulse = exp(-d * d * 900.0) * uPulse * 6.0;
  gl_FragColor = vec4(uColor * (uBase + head + pulse), 1.0);
}`,
}

/** HUD arc gauge: a RingGeometry sector whose lit fraction is bound to a real value (0..1). */
export const gauge = {
  vertex: /* glsl */ `
varying vec2 vPos;
void main() { vPos = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragment: /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uAlpha; uniform float uFill; uniform float uStart; uniform float uLength;
varying vec2 vPos;
void main() {
  float a = atan(vPos.y, vPos.x);
  float t = mod(a - uStart, 6.2831853) / uLength;
  float lit = step(t, uFill);
  float tick = step(0.9, fract(t * 20.0));
  gl_FragColor = vec4(uColor * (0.18 + lit * 0.82 + tick * 0.15), uAlpha);
}`,
}

/**
 * Particles in three depth layers. Radial flow is driven by a CPU-integrated phase so changing direction
 * never jumps. Size attenuates with depth; the near layer renders as large defocused discs.
 */
export const particles = {
  vertex: /* glsl */ `
attribute float aSeed; attribute float aRadius; attribute float aAngle; attribute float aSpeed; attribute float aZ;
uniform float uTime; uniform float uPhase; uniform float uRMin; uniform float uRMax; uniform float uFlowAmt;
uniform float uSize; uniform float uPixelRatio; uniform float uViewH; uniform float uDensity;
varying float vAlpha; varying float vSeed;
void main() {
  float span = uRMax - uRMin;
  float flowR = uRMin + span * fract(aRadius + uPhase * (0.6 + aSpeed * 4.0));
  float r = mix(uRMin + span * aRadius, flowR, uFlowAmt);
  float ang = aAngle + uTime * aSpeed;
  vec3 pos = vec3(cos(ang) * r, sin(ang) * r, aZ);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float edge = smoothstep(0.0, 0.12, (r - uRMin) / span) * smoothstep(1.0, 0.75, (r - uRMin) / span);
  vAlpha = mix(1.0, edge, uFlowAmt) * step(aSeed, uDensity);
  vSeed = aSeed;
  gl_PointSize = uSize * (0.55 + aSeed * 0.9) * uPixelRatio * uViewH / (-mv.z * 900.0);
}`,
  fragment: /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uAlpha; uniform float uTime; uniform float uSoft;
varying float vAlpha; varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float disc = mix(exp(-d * d * 7.0), smoothstep(1.0, 0.6, d) * 0.6 + exp(-d * d * 4.0) * 0.4, uSoft);
  float twinkle = 0.75 + 0.25 * sin(uTime * (0.7 + vSeed * 1.7) + vSeed * 40.0);
  gl_FragColor = vec4(uColor * disc * uAlpha * vAlpha * twinkle, 1.0);
}`,
}

/** Agent link: O rim → agent node. An energy packet travels outward while the agent runs. */
export const link = {
  vertex: /* glsl */ `
attribute float aS; attribute float aSlot;
varying float vS; varying float vSlot;
void main() { vS = aS; vSlot = aSlot; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragment: /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uTime; uniform float uIntensity[6]; uniform float uRunning[6];
varying float vS; varying float vSlot;
void main() {
  int i = int(vSlot + 0.5);
  float inten = 0.0; float run = 0.0;
  for (int k = 0; k < 6; k++) { if (k == i) { inten = uIntensity[k]; run = uRunning[k]; } }
  float packet = exp(-pow(fract(uTime * 0.6 + vSlot * 0.17) - vS, 2.0) * 300.0) * run * 4.0;
  float body = (0.12 + 0.25 * (1.0 - vS)) * inten;
  gl_FragColor = vec4(uColor * (body + packet * inten), 1.0);
}`,
}

/** Near-black void with a faint cool lift behind the Orb. Drawn first, never bloomed. */
export const background = {
  vertex: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.9999, 1.0); }`,
  fragment: /* glsl */ `
precision highp float;
uniform vec3 uTint; uniform float uLift; uniform float uAspect;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(p);
  vec3 col = vec3(0.0016, 0.0020, 0.0028) + uTint * 0.006 * exp(-r * r * 5.0) * uLift;
  gl_FragColor = vec4(col, 1.0);
}`,
}

/**
 * Final composite: scene (HDR) + selective bloom + anamorphic streak (from the bloom buffer only) →
 * exposure → ACES filmic → vignette → very subtle radial chromatic aberration → sRGB → grain.
 */
export const composite = {
  vertex: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragment: /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse; uniform sampler2D tBloom;
uniform float uBloom; uniform float uStreak; uniform float uExposure; uniform float uVignette;
uniform float uGrain; uniform float uCA; uniform float uTime; uniform vec2 uTexel; uniform float uAspect;
uniform float uHasBloom;
varying vec2 vUv;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 d = vUv - 0.5;
  vec2 ca = d * dot(d, d) * uCA;
  vec3 col = vec3(texture2D(tDiffuse, vUv - ca).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + ca).b);
  if (uHasBloom > 0.5) {
    vec3 bloom = texture2D(tBloom, vUv).rgb;
    vec3 streak = vec3(0.0);
    for (int i = 1; i <= 16; i++) {
      float fi = float(i);
      vec2 o = vec2(uTexel.x * fi * 3.5, 0.0);
      float w = exp(-fi * 0.16) * 0.55;
      streak += (texture2D(tBloom, vUv + o).rgb + texture2D(tBloom, vUv - o).rgb) * w;
    }
    col += bloom * uBloom + streak * uStreak * vec3(0.72, 0.86, 1.0);
  }
  col = aces(col * uExposure);
  vec2 v = d * vec2(uAspect, 1.0);
  col *= 1.0 - uVignette * smoothstep(0.25, 1.05, length(v));
  col = toSRGB(col);
  col += (hash(vUv * 1931.0 + fract(uTime) * 71.0) - 0.5) * uGrain;
  gl_FragColor = vec4(col, 1.0);
}`,
}

/** Cheap fresnel shell for the outer glass cylinder (edges catch light, faces stay clear). */
export const fresnelShell = {
  vertex: /* glsl */ `
varying vec3 vN; varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`,
  fragment: /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uIntensity;
varying vec3 vN; varying vec3 vV;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 4.0);
  gl_FragColor = vec4(uColor * f * uIntensity, 1.0);
}`,
}
