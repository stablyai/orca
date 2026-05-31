import { describe, expect, it } from 'vitest'

import { clampPositionToViewport } from './PetOverlay'

describe('clampPositionToViewport', () => {
  it('keeps positions inside the viewport minus pet size', () => {
    expect(
      clampPositionToViewport({ x: 480, y: 390 }, 120, {
        width: 500,
        height: 400
      })
    ).toEqual({ x: 380, y: 280 })
  })

  it('clamps negative positions to the origin', () => {
    expect(
      clampPositionToViewport({ x: -25, y: -40 }, 120, {
        width: 500,
        height: 400
      })
    ).toEqual({ x: 0, y: 0 })
  })
})
