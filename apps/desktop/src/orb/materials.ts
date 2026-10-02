// Material system for the Orb: a procedural studio environment (for metal reflections), machined-metal
// textures, and the differentiated materials — graphite structure, polished edges, optical glass, emissive.
import * as THREE from 'three'

/**
 * Studio environment rendered once into a PMREM. Black void with a few controlled light sources:
 * a ring light behind the camera (circular highlights on round machined faces), thin vertical strips at
 * the sides (bright chamfer edges), a soft top key. Cool white, never saturated.
 */
export function createEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const env = new THREE.Scene()
  env.background = new THREE.Color(0x000000)
  const add = (geo: THREE.BufferGeometry, intensity: number, pos: [number, number, number], color = 0xdfeaff) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }))
    m.position.set(...pos)
    m.lookAt(0, 0, 0)
    env.add(m)
    return m
  }
  // Ring light behind the camera.
  add(new THREE.TorusGeometry(3.2, 0.09, 8, 96), 3.2, [0, 0, 7])
  // Edge strips left and right, slightly forward.
  add(new THREE.PlaneGeometry(0.22, 9), 5, [-6, 0.6, 3])
  add(new THREE.PlaneGeometry(0.16, 9), 3.5, [6, -0.4, 3.5], 0xd2e2ff)
  // Soft top key.
  add(new THREE.PlaneGeometry(7, 1.4), 1.6, [0, 6, 2])
  // Very faint floor bounce so lower chamfers aren't dead black.
  add(new THREE.PlaneGeometry(10, 3), 0.18, [0, -6, 1], 0x8fa4c0)
  // Cool rim from behind (back faces of rings).
  add(new THREE.PlaneGeometry(10, 0.3), 1.2, [0, 1, -6], 0xa9c8ff)

  const pmrem = new THREE.PMREMGenerator(renderer)
  const rt = pmrem.fromScene(env, 0.015)
  pmrem.dispose()
  env.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose()
      ;(o.material as THREE.Material).dispose()
    }
  })
  return rt.texture
}

/**
 * Lathe-turned surface: concentric machining grooves along the profile (v) as a tangent-space normal map,
 * plus banded roughness. Lathe UVs run u = around the axis, v = along the profile, so grooves read as rings.
 */
export function machinedTextures(): { normal: THREE.DataTexture; roughness: THREE.DataTexture } {
  const H = 1024
  const W = 4
  const n = new Uint8Array(W * H * 4)
  const r = new Uint8Array(W * H * 4)
  const height = (v: number) => 0.6 * Math.sin(v * Math.PI * 2 * 220) + 0.4 * Math.sin(v * Math.PI * 2 * 37 + 1.3)
  for (let y = 0; y < H; y++) {
    const v = y / H
    const dh = (height(v + 1 / H) - height(v - 1 / H)) * 0.5
    const nx = 0
    const ny = -dh * 0.9
    const len = Math.hypot(nx, ny, 1)
    const band = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 9)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      n[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255)
      n[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255)
      n[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255)
      n[i + 3] = 255
      const rough = 0.82 + band * 0.18 // multiplies material.roughness
      r[i] = r[i + 1] = r[i + 2] = Math.round(rough * 255)
      r[i + 3] = 255
    }
  }
  const make = (data: Uint8Array) => {
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.magFilter = THREE.LinearFilter
    t.minFilter = THREE.LinearMipmapLinearFilter
    t.generateMipmaps = true
    t.colorSpace = THREE.NoColorSpace
    t.needsUpdate = true
    return t
  }
  return { normal: make(n), roughness: make(r) }
}

/** Fine isotropic micro-texture for flat plates (A/P faces) — breaks the CG-perfect look without visible pattern. */
export function plateTexture(): THREE.DataTexture {
  const S = 256
  const d = new Uint8Array(S * S * 4)
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < S * S; i++) {
    const brushed = 0.5 + 0.5 * Math.sin((i % S) * 0.9 + rnd() * 2)
    const v = 0.8 + 0.12 * rnd() + 0.08 * brushed
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = Math.round(v * 255)
    d[i * 4 + 3] = 255
  }
  const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(3, 3)
  t.colorSpace = THREE.NoColorSpace
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.needsUpdate = true
  return t
}

export interface OrbMaterials {
  /** The O housing: dark graphite, circular brushing, lathe grooves, thin clearcoat. */
  housing: THREE.MeshPhysicalMaterial
  /** A/P plate faces: darker, rougher. */
  plate: THREE.MeshPhysicalMaterial
  /** A/P sides + chamfers: polished, catches the strip lights → bright edges. */
  edge: THREE.MeshPhysicalMaterial
  /** Segmented mechanical rings. */
  ring: THREE.MeshPhysicalMaterial
  /** Barrel interior: light-absorbing, lit mostly by the nucleus. */
  interior: THREE.MeshPhysicalMaterial
  /** Polished reflective ring / agent beads. */
  chrome: THREE.MeshPhysicalMaterial
  /** Optical glass with AR-coating sheen (thin-film iridescence). */
  glass: THREE.MeshPhysicalMaterial
  /** Same glass without transmission (LOW quality / glass disabled). */
  glassLite: THREE.MeshPhysicalMaterial
  /** Black occluder used in the selective-bloom pass. */
  occluder: THREE.MeshBasicMaterial
  /** Materials whose env reflection is driven by the visual `metal` value. */
  structural: THREE.MeshPhysicalMaterial[]
}

export function createMaterials(): OrbMaterials {
  const machined = machinedTextures()
  const plate = plateTexture()
  const housing = new THREE.MeshPhysicalMaterial({
    color: 0x1e2229,
    metalness: 1,
    roughness: 0.3,
    roughnessMap: machined.roughness,
    normalMap: machined.normal,
    normalScale: new THREE.Vector2(0.35, 0.35),
    anisotropy: 0.6,
    clearcoat: 0.35,
    clearcoatRoughness: 0.12,
    side: THREE.DoubleSide,
  })
  const plateMat = new THREE.MeshPhysicalMaterial({ color: 0x4a525e, metalness: 0.5, roughness: 0.42, roughnessMap: plate, anisotropy: 0.3, clearcoat: 0.25, clearcoatRoughness: 0.25 })
  const edge = new THREE.MeshPhysicalMaterial({ color: 0x8a94a3, metalness: 1, roughness: 0.18, anisotropy: 0.4 })
  const ring = new THREE.MeshPhysicalMaterial({ color: 0x272c34, metalness: 1, roughness: 0.27, anisotropy: 0.5, clearcoat: 0.25, clearcoatRoughness: 0.1 })
  const interior = new THREE.MeshPhysicalMaterial({
    color: 0x0d1014,
    metalness: 0.85,
    roughness: 0.45,
    roughnessMap: machined.roughness,
    normalMap: machined.normal,
    normalScale: new THREE.Vector2(0.5, 0.5),
    side: THREE.DoubleSide,
  })
  const chrome = new THREE.MeshPhysicalMaterial({ color: 0xc4cedb, metalness: 1, roughness: 0.07 })
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.012,
    transmission: 1,
    thickness: 0.06,
    ior: 1.52,
    attenuationColor: new THREE.Color(0.82, 0.92, 1.0),
    attenuationDistance: 4,
    specularIntensity: 1,
    iridescence: 0.28,
    iridescenceIOR: 1.32,
    iridescenceThicknessRange: [160, 420],
    envMapIntensity: 1.0,
    side: THREE.DoubleSide,
  })
  const glassLite = new THREE.MeshPhysicalMaterial({
    color: 0xb8d4ff,
    metalness: 0,
    roughness: 0.04,
    transparent: true,
    opacity: 0.12,
    iridescence: 0.35,
    iridescenceIOR: 1.32,
    depthWrite: false,
    envMapIntensity: 1.2,
    side: THREE.DoubleSide,
  })
  return {
    housing,
    plate: plateMat,
    edge,
    ring,
    interior,
    chrome,
    glass,
    glassLite,
    occluder: new THREE.MeshBasicMaterial({ color: 0x000000 }),
    structural: [housing, plateMat, edge, ring, interior, chrome],
  }
}
