import { describe, expect, it } from 'vitest'
import { advancePetWalk, petWalkBounds, petLaneY } from './pet-walk-lane'

describe('advancePetWalk', () => {
  it('moves right at the given speed', () => {
    const next = advancePetWalk(
      { x: 100, direction: 'right' },
      { deltaMs: 500, speedPxPerSec: 40, minX: 0, maxX: 1000 }
    )
    expect(next).toEqual({ x: 120, direction: 'right' })
  })

  it('moves left at the given speed', () => {
    const next = advancePetWalk(
      { x: 100, direction: 'left' },
      { deltaMs: 500, speedPxPerSec: 40, minX: 0, maxX: 1000 }
    )
    expect(next).toEqual({ x: 80, direction: 'left' })
  })

  it('turns around at the right edge instead of overshooting', () => {
    const next = advancePetWalk(
      { x: 995, direction: 'right' },
      { deltaMs: 1000, speedPxPerSec: 40, minX: 0, maxX: 1000 }
    )
    expect(next).toEqual({ x: 1000, direction: 'left' })
  })

  it('turns around at the left edge instead of overshooting', () => {
    const next = advancePetWalk(
      { x: 5, direction: 'left' },
      { deltaMs: 1000, speedPxPerSec: 40, minX: 0, maxX: 1000 }
    )
    expect(next).toEqual({ x: 0, direction: 'right' })
  })

  it('stays put without flipping when the window is narrower than the pet', () => {
    const step = { deltaMs: 16, speedPxPerSec: 40, minX: 0, maxX: 0 }
    const first = advancePetWalk({ x: 0, direction: 'right' }, step)
    const second = advancePetWalk(first, step)
    expect(first).toEqual({ x: 0, direction: 'right' })
    expect(second).toEqual({ x: 0, direction: 'right' })
  })
})

describe('petWalkBounds', () => {
  it('spans the viewport minus the pet width', () => {
    expect(petWalkBounds(1200, 180)).toEqual({ minX: 0, maxX: 1020 })
  })

  it('collapses to a single point when the pet is wider than the viewport', () => {
    expect(petWalkBounds(100, 180)).toEqual({ minX: 0, maxX: 0 })
  })
})

describe('petLaneY', () => {
  it('drops the pet box against the bottom inset', () => {
    expect(petLaneY(800, 180, 24)).toBe(596)
  })

  it('never returns a negative offset on a short viewport', () => {
    expect(petLaneY(100, 180, 24)).toBe(0)
  })
})
