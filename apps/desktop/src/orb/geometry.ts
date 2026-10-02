// Geometry builders for the Orb. Units: 1 = the O's outer radius. +z points at the camera.
import * as THREE from 'three'
import { markPolylines } from './mark'

type P2 = [number, number]

/**
 * Lathe around the Z axis from a (radius, z) profile. The profile is walked so that normals face out
 * (outer wall upward, front face inward, bore downward). Corners get micro-offsets so flat faces keep hard
 * normals and only the corner itself is rounded — which is what produces the thin bright edge highlight.
 */
export function lathe(profile: P2[], segments = 160, hard = true): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = []
  const eps = 0.0012
  profile.forEach(([r, z], i) => {
    if (!hard || i === 0 || i === profile.length - 1) {
      pts.push(new THREE.Vector2(r, z))
      return
    }
    const [pr, pz] = profile[i - 1]!
    const [nr, nz] = profile[i + 1]!
    const dPrev = new THREE.Vector2(r - pr, z - pz).normalize()
    const dNext = new THREE.Vector2(nr - r, nz - z).normalize()
    pts.push(new THREE.Vector2(r - dPrev.x * eps, z - dPrev.y * eps), new THREE.Vector2(r, z), new THREE.Vector2(r + dNext.x * eps, z + dNext.y * eps))
  })
  const g = new THREE.LatheGeometry(pts, segments)
  g.rotateX(Math.PI / 2) // lathe axis Y → Z (profile height becomes depth)
  return g
}

/** The O housing: chamfered outer lip, recessed channel for the glass ring, inner lip, deep bore. */
export const O_PROFILE: P2[] = [
  [0.985, -0.36],
  [1.0, -0.33],
  [1.0, 0.02],
  [0.988, 0.075],
  [0.968, 0.1],
  [0.905, 0.1],
  [0.893, 0.086],
  [0.862, 0.086],
  [0.862, 0.066],
  [0.802, 0.066],
  [0.802, 0.086],
  [0.742, 0.086],
  [0.726, 0.104],
  [0.69, 0.104],
  [0.668, 0.082],
  [0.655, 0.04],
  [0.647, -0.02],
  [0.647, -0.96],
]

/** A retaining ring seated inside the bore at depth z (faces the camera and the axis). */
export function retainingRing(z: number, inner: number, h = 0.05): THREE.BufferGeometry {
  return lathe([
    [0.647, z],
    [inner + 0.012, z],
    [inner, z - 0.012],
    [inner, z - h],
  ])
}

/** Biconvex / meniscus lens element (closed solid of revolution), centered at z. */
export function lensElement(radius: number, center: number, edge: number, curveFront: number, curveBack = curveFront): THREE.BufferGeometry {
  const steps = 18
  const pts: P2[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    pts.push([radius * t, -center / 2 + (center - edge) * 0.5 * t * t * curveBack])
  }
  pts.push([radius, edge / 2])
  for (let i = steps; i >= 0; i--) {
    const t = i / steps
    pts.push([radius * t, center / 2 - (center - edge) * 0.5 * t * t * curveFront])
  }
  return lathe(pts, 128, false)
}

/** Annular sector solid (one segment of a mechanical ring), extruded along z. */
export function annularSector(r0: number, r1: number, angle: number, depth: number, bevel = 0.004): THREE.BufferGeometry {
  const s = new THREE.Shape()
  const a0 = -angle / 2
  const a1 = angle / 2
  s.moveTo(Math.cos(a0) * r0, Math.sin(a0) * r0)
  s.absarc(0, 0, r0, a0, a1, false)
  s.lineTo(Math.cos(a1) * r1, Math.sin(a1) * r1)
  s.absarc(0, 0, r1, a1, a0, true)
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 8 })
  g.translate(0, 0, -depth / 2)
  return g
}

/** One iris blade: a curved vane pivoting at the bore wall. Rotated about its pivot to open/close. */
export function irisBlade(): THREE.BufferGeometry {
  const s = new THREE.Shape()
  // Drawn in pivot space: pivot at origin, vane sweeping toward the axis along a gentle arc.
  s.moveTo(0, -0.03)
  s.quadraticCurveTo(-0.22, -0.06, -0.46, 0.08)
  s.lineTo(-0.44, 0.15)
  s.quadraticCurveTo(-0.2, 0.05, 0.02, 0.06)
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.006, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 1, curveSegments: 16 })
  return g
}

function signedArea(pts: P2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!
    const [x1, y1] = pts[(i + 1) % pts.length]!
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

function shapeFrom(pts: P2[]): THREE.Shape {
  const ccw = signedArea(pts) > 0 ? pts : [...pts].reverse()
  return new THREE.Shape(ccw.map(([x, y]) => new THREE.Vector2(x, y)))
}

export interface MarkGeometry {
  a: THREE.BufferGeometry
  p: THREE.BufferGeometry
  /** Illuminated inlay strips (A → O → P light path), with aS = arc length 0..1 along the path. */
  strips: THREE.BufferGeometry
  depth: number
}

/**
 * A and P as machined plates: extruded, bevelled, front face at z = 0. They pass *behind* the O so the
 * housing occludes their junctions. Inlay strips sit just in front of the plates, inset from an edge.
 */
export function markGeometry(depth = 0.13): MarkGeometry {
  const { a, p } = markPolylines()
  const bevel = { bevelEnabled: true, bevelThickness: 0.014, bevelSize: 0.011, bevelSegments: 3, curveSegments: 24 }
  const ag = new THREE.ExtrudeGeometry(shapeFrom(a), { depth, ...bevel })
  const pg = new THREE.ExtrudeGeometry(shapeFrom(p), { depth, ...bevel })
  ag.translate(0, 0, -depth - 0.014)
  pg.translate(0, 0, -depth - 0.014)

  // Light path: A's right outer leg (apex → where it meets the O), then the P's top edge and outer bowl.
  const inset = (path: P2[], poly: P2[], d: number): P2[] => {
    const sign = signedArea(poly) > 0 ? 1 : -1
    return path.map((pt, i) => {
      const prev = path[Math.max(0, i - 1)]!
      const next = path[Math.min(path.length - 1, i + 1)]!
      const tx = next[0] - prev[0]
      const ty = next[1] - prev[1]
      const l = Math.hypot(tx, ty) || 1
      // Inward normal for a CCW polygon is the left normal (−ty, tx).
      return [pt[0] + (-ty / l) * d * sign, pt[1] + (tx / l) * d * sign]
    })
  }
  const aLeft = inset([a[7]!, a[8]!], a, 0.035)
  const aPath = inset([a[8]!, a[9]!], a, 0.035)
  const pBowl = p.slice(0, 27)
  const pPath = inset(pBowl, p, 0.038)
  const strips = ribbon([aLeft, aPath, pPath], 0.007, 0.003)
  return { a: ag, p: pg, strips, depth }
}

/** Flat ribbons along polylines (z = zOff), attribute aS = normalized arc length across all paths in order. */
export function ribbon(paths: P2[][], width: number, zOff = 0): THREE.BufferGeometry {
  const pos: number[] = []
  const s: number[] = []
  const idx: number[] = []
  let total = 0
  const lens = paths.map((path) => {
    let l = 0
    for (let i = 1; i < path.length; i++) l += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1])
    total += l
    return l
  })
  let acc = 0
  paths.forEach((path, pi) => {
    let local = 0
    const start = pos.length / 3
    path.forEach((pt, i) => {
      if (i > 0) local += Math.hypot(pt[0] - path[i - 1]![0], pt[1] - path[i - 1]![1])
      const prev = path[Math.max(0, i - 1)]!
      const next = path[Math.min(path.length - 1, i + 1)]!
      const tx = next[0] - prev[0]
      const ty = next[1] - prev[1]
      const l = Math.hypot(tx, ty) || 1
      const nx = (-ty / l) * width * 0.5
      const ny = (tx / l) * width * 0.5
      pos.push(pt[0] + nx, pt[1] + ny, zOff, pt[0] - nx, pt[1] - ny, zOff)
      const u = (acc + local) / total
      s.push(u, u)
    })
    for (let i = 0; i < path.length - 1; i++) {
      const k = start + i * 2
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
    }
    acc += lens[pi]!
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aS', new THREE.Float32BufferAttribute(s, 1))
  g.setIndex(idx)
  return g
}

/** Thin flat arc (precision HUD line) as triangles — anti-aliased by MSAA, unlike GL lines. */
export function arcBand(r: number, width: number, a0: number, a1: number, segments = 96): THREE.BufferGeometry {
  return new THREE.RingGeometry(r - width / 2, r + width / 2, Math.max(4, Math.round(segments * Math.abs(a1 - a0) / (Math.PI * 2))), 1, a0, a1 - a0)
}

/** Straight hairline from (x0,y0) to (x1,y1). */
export function hairline(x0: number, y0: number, x1: number, y1: number, width: number): THREE.BufferGeometry {
  const len = Math.hypot(x1 - x0, y1 - y0)
  const g = new THREE.PlaneGeometry(len, width)
  g.rotateZ(Math.atan2(y1 - y0, x1 - x0))
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, 0)
  return g
}
