import { describe, expect, it } from 'vitest'
import { magentaScore } from './pet-magenta-key'

describe('magentaScore', () => {
  it('fully keys the magenta the exporters actually write', () => {
    expect(magentaScore(255, 0, 255)).toBe(1)
  })

  it('leaves anything greener than it is magenta alone', () => {
    expect(magentaScore(120, 200, 120)).toBe(0)
    expect(magentaScore(255, 255, 255)).toBe(0)
    expect(magentaScore(0, 0, 0)).toBe(0)
  })

  it('fades a compressed halo instead of erasing it', () => {
    // The comment on this function has always promised antialiased edges fade.
    // They did not: every scored pixel cleared to zero, because the threshold
    // and the multiplier together could never produce a score below 0.5.
    const halo = magentaScore(255, 128, 255)

    expect(halo).toBeGreaterThan(0)
    expect(halo).toBeLessThan(0.5)
  })

  it('rises with how strongly red and blue dominate green', () => {
    expect(magentaScore(255, 40, 255)).toBeGreaterThan(magentaScore(255, 120, 255))
  })

  it('never keys a pixel it does not consider magenta at all', () => {
    // A dull olive: red and blue do not dominate.
    expect(magentaScore(90, 95, 40)).toBe(0)
  })
})
