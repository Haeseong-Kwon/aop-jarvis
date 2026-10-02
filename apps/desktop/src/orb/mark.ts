// AOP brand mark, reconstructed from the supplied logo (aop-note/image/logo image.png, 1000×1000) by
// sampling its pixel runs. Logo-space measurements, then normalized so the O's outer radius = 1 and
// its center = origin (y up). This module is the single geometric source for the Orb and assets/aop-mark.svg.
//
//   A = left structural frame — its right leg runs tangent into the O's lower-left; crossbar stops short.
//   O = central optical core — outer r 119px, inner r 77px.
//   P = right structural frame — the O itself forms the left wall of the P's bowl.

type V = [number, number]

const O_CENTER: V = [501, 481]
const O_OUTER = 119
const O_INNER = 77
const LEG_SLOPE = 0.56 // dx/dy of the A's right leg (measured)

export const O_INNER_RATIO = O_INNER / O_OUTER

const norm = ([x, y]: V): V => [(x - O_CENTER[0]) / O_OUTER, -(y - O_CENTER[1]) / O_OUTER]

/** Where a leg line x = x0 + s·(y − y0) meets the O's outer circle (lower intersection). */
function legMeetsO(x0: number, y0: number): V {
  // Parametrize by y: (x0 + s(y−y0) − cx)² + (y − cy)² = R²
  const [cx, cy] = O_CENTER
  const a = LEG_SLOPE * LEG_SLOPE + 1
  const k = x0 - LEG_SLOPE * y0 - cx
  const b = 2 * (LEG_SLOPE * k - cy)
  const c = k * k + cy * cy - O_OUTER * O_OUTER
  const disc = b * b - 4 * a * c
  // The inner edge only grazes the O (tangent, ~4px outside): use the closest point instead.
  const y = disc >= 0 ? (-b - Math.sqrt(disc)) / (2 * a) : -b / (2 * a)
  return [x0 + LEG_SLOPE * (y - y0), y]
}

function arc(c: V, r: number, from: number, to: number, steps: number): V[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = from + ((to - from) * i) / steps
    return [c[0] + r * Math.cos(t), c[1] - r * Math.sin(t)] as V
  })
}

/** The A as an open polyline (the segment hidden inside the O is omitted). Logo space. */
export function aFrame(): V[] {
  const outerMeet = legMeetsO(331, 345)
  const innerMeet = legMeetsO(335, 436)
  return [
    innerMeet,
    [332, 431], // inner apex
    [288, 516], // left leg inner edge at crossbar top
    [345, 516], // crossbar end, cut parallel to the right leg
    [365, 552],
    [269, 552],
    [244, 600], // left leg inner foot
    [197, 600], // left leg outer foot
    [331, 345], // apex
    outerMeet,
  ]
}

/** The P as a closed polyline. The bowl's open left side is bounded by the O. Logo space. */
export function pFrame(): V[] {
  const H = Math.PI / 2
  return [
    [592, 362],
    [694, 362],
    ...arc([694, 452], 90, H, -H, 24), // outer bowl
    [670, 542],
    [670, 600],
    [628, 600],
    [628, 548],
    [637, 532],
    [643, 496],
    ...arc([694, 448], 47, -H, H, 16).slice(0), // inner bowl, back up
    [627, 401],
    [592, 362],
  ]
}

export const markPolylines = (): { a: V[]; p: V[] } => ({ a: aFrame().map(norm), p: pFrame().map(norm) })

/** SVG path data in logo space (used to generate assets/aop-mark.svg). */
export function markSvgPaths(): { a: string; p: string; o: string } {
  const d = (pts: V[], close: boolean) => `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')}${close ? ' Z' : ''}`
  const [cx, cy] = O_CENTER
  const ring = (r: number) => `M${cx - r},${cy} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0`
  return { a: d(aFrame(), true), p: d(pFrame(), true), o: `${ring(O_OUTER)} ${ring(O_INNER)}` }
}
