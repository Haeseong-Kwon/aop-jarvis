import { describe, expect, it } from 'vitest'
import { EASE, Timeline, timelineClock } from '../src/timeline'

const tl = new Timeline([
  { id: 'core', at: 0.2, dur: 0.3, motion: 'energize', event: 'assembly:core-ignite', sound: 'ignite' },
  { id: 'ring', at: 1.0, dur: 0.4, motion: 'lock', count: 4, stagger: 0.07, sound: 'lock', soundEach: true },
])

describe('Timeline', () => {
  it('is deterministic and reaches exactly 1 at the end of each instance', () => {
    expect(tl.p('core', 0)).toBe(0)
    expect(tl.p('core', 0.5)).toBe(1)
    expect(tl.p('ring', 1.0 + 3 * 0.07 + 0.4, 3)).toBe(1)
    expect(tl.p('ring', 1.0 + 0.4, 3)).toBeLessThan(1) // later instances are staggered
    expect(tl.duration).toBeCloseTo(1.0 + 3 * 0.07 + 0.4)
  })

  it('emits events once and sounds per instance, in time order', () => {
    const cues = tl.cuesBetween(0, 2)
    expect(cues.map((c) => `${c.kind}:${c.name}`)).toEqual(['event:assembly:core-ignite', 'sound:ignite', 'sound:lock', 'sound:lock', 'sound:lock', 'sound:lock'])
    expect(tl.cuesBetween(0.2, 1.0).map((c) => c.name)).toEqual(['lock']) // (from, to]
  })

  it('motion profiles start at 0, end at 1; snap overshoots, calibrate steps', () => {
    for (const f of Object.values(EASE)) {
      expect(f(0)).toBeCloseTo(0, 5)
      expect(f(1)).toBeCloseTo(1, 5)
    }
    expect(Math.max(...Array.from({ length: 100 }, (_, i) => EASE.snap(i / 100)))).toBeGreaterThan(1)
    expect(EASE.calibrate(0.5)).toBe(EASE.calibrate(0.51))
  })

  it('pulses briefly right after an instance lands', () => {
    const end = 1.0 + 0.4
    expect(tl.pulse('ring', end - 0.01)).toBe(0)
    expect(tl.pulse('ring', end + 0.06)).toBeGreaterThan(0)
    expect(tl.pulse('ring', end + 0.5)).toBe(0)
  })

  it('skip accelerates the remainder instead of jumping', () => {
    expect(timelineClock(2000, 0, null)).toBe(2)
    expect(timelineClock(2000, 0, 1000)).toBe(1 + 1 * 6)
    expect(timelineClock(900, 0, 1000)).toBeCloseTo(0.9)
  })

  it('rejects duplicate ids', () => {
    expect(() => new Timeline([{ id: 'x', at: 0, dur: 1, motion: 'fade' }, { id: 'x', at: 1, dur: 1, motion: 'fade' }])).toThrow()
  })
})
