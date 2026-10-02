// A and P as separate machined pieces (for the mechanical assembly). Polygons are in logo space (the
// supplied AOP logo, 1000 px), measured from its pixel runs — the same source as mark.ts — and tile the
// letterforms exactly when assembled.
import * as THREE from 'three'

type V = [number, number]
const O_CENTER: V = [501, 481]
const O_OUTER = 119
const LEG_SLOPE = 0.56

const norm = ([x, y]: V): V => [(x - O_CENTER[0]) / O_OUTER, -(y - O_CENTER[1]) / O_OUTER]

function legMeetsO(x0: number, y0: number): V {
  const [cx, cy] = O_CENTER
  const a = LEG_SLOPE * LEG_SLOPE + 1
  const k = x0 - LEG_SLOPE * y0 - cx
  const b = 2 * (LEG_SLOPE * k - cy)
  const c = k * k + cy * cy - O_OUTER * O_OUTER
  const disc = b * b - 4 * a * c
  const y = disc >= 0 ? (-b - Math.sqrt(disc)) / (2 * a) : -b / (2 * a)
  return [x0 + LEG_SLOPE * (y - y0), y]
}

function arc(c: V, r: number, from: number, to: number, steps: number): V[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = from + ((to - from) * i) / steps
    return [c[0] + r * Math.cos(t), c[1] - r * Math.sin(t)] as V
  })
}

export interface Piece {
  name: string
  geometry: THREE.BufferGeometry
  /** Pivot in orb units; the geometry is translated so the pivot is its origin. */
  pivot: V
}

const H = Math.PI / 2

/** Logo-space polygons of each piece. */
export function piecePolygons(): Record<string, { poly: V[]; pivot: V }> {
  const outerMeet = legMeetsO(331, 345)
  const innerMeet = legMeetsO(335, 436)
  return {
    // A — left leg (the "lower segment" that slides up), right leg (rotates inward about the apex), crossbar.
    aLeft: { poly: [[197, 600], [244, 600], [332, 431], [331, 345]], pivot: [220, 600] },
    aRight: { poly: [[331, 345], outerMeet, innerMeet, [332, 431]], pivot: [331, 345] },
    aBar: { poly: [[288, 516], [345, 516], [365, 552], [269, 552]], pivot: [316, 534] },
    // P — spine + bottom bar, bowl (rotates around the O), top bar.
    pSpine: { poly: [[694, 542], [670, 542], [670, 600], [628, 600], [628, 548], [637, 532], [643, 496], [694, 495]], pivot: [649, 600] },
    pBowl: { poly: [...arc([694, 452], 90, H, -H, 32), ...arc([694, 448], 47, -H, H, 20)], pivot: O_CENTER },
    pTop: { poly: [[592, 362], [694, 362], [694, 401], [627, 401]], pivot: [643, 381] },
  }
}

export function buildPieces(depth = 0.13): Record<string, Piece> {
  const bevel = { bevelEnabled: true, bevelThickness: 0.014, bevelSize: 0.01, bevelSegments: 3, curveSegments: 24 }
  const out: Record<string, Piece> = {}
  for (const [name, { poly, pivot }] of Object.entries(piecePolygons())) {
    const pts = poly.map(norm)
    const pv = norm(pivot)
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x - pv[0], y - pv[1])))
    const g = new THREE.ExtrudeGeometry(shape, { depth, ...bevel })
    g.translate(0, 0, -depth - 0.014)
    out[name] = { name, geometry: g, pivot: pv }
  }
  return out
}
