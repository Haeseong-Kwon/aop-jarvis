// GLSL for the AOP Orb. Emissive shaders write HDR linear values; the composite pass tone-maps once.
// Orb units: 1.0 = the O's outer radius.

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

