// Flat HUD geometry helpers (orb units).
import * as THREE from 'three'

/** Flat annular band (HUD arcs, gauges). */
export function arcBand(r: number, width: number, a0: number, a1: number, segments = 96): THREE.BufferGeometry {
  return new THREE.RingGeometry(r - width / 2, r + width / 2, Math.max(4, Math.round(segments * Math.abs(a1 - a0) / (Math.PI * 2))), 1, a0, a1 - a0)
}
