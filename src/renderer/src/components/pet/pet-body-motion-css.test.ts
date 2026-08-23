import { describe, expect, it } from 'vitest'
import { petBodyMotionStyle } from './pet-body-motion-css'

const base = {
  held: false,
  landing: false,
  motionAllowed: true,
  landingDurationMs: 220,
  selfAnimated: true,
  supine: false,
  rising: false,
  supineLiftPx: 70,
  risingDurationMs: 1200
}

describe('petBodyMotionStyle', () => {
  it('tips the pet onto its back, pivoting on its feet', () => {
    const style = petBodyMotionStyle({ ...base, supine: true })

    expect(style.transform).toContain('rotate(-90deg)')
    // Rotated about the feet, half the body would sink below the lane; lift it.
    expect(style.transform).toContain('translateY(-70px)')
    expect(style.transformOrigin).toBe('50% 100%')
    expect(style.animation).toBe('none')
  })

  it('stands back up slowly rather than snapping upright', () => {
    const style = petBodyMotionStyle({ ...base, rising: true })

    expect(style.transform).toBe('none')
    expect(style.transition).toContain('1200ms')
  })

  it('keeps the landing squash for a drop too short to topple', () => {
    const style = petBodyMotionStyle({ ...base, landing: true })

    expect(style.animation).toContain('pet-land-squash')
    expect(style.transform).toBeUndefined()
  })
})
