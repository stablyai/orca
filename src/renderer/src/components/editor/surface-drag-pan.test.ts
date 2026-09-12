import { describe, expect, it } from 'vitest'
import { getPannedScrollOffsets, shouldStartSurfacePan } from './surface-drag-pan'

const origin = {
  pointerId: 1,
  clientX: 200,
  clientY: 150,
  scrollLeft: 400,
  scrollTop: 300
}

describe('shouldStartSurfacePan', () => {
  it('starts on a primary mouse or pen press', () => {
    expect(shouldStartSurfacePan({ button: 0, pointerType: 'mouse' })).toBe(true)
    expect(shouldStartSurfacePan({ button: 0, pointerType: 'pen' })).toBe(true)
  })

  it('ignores secondary buttons', () => {
    expect(shouldStartSurfacePan({ button: 1, pointerType: 'mouse' })).toBe(false)
    expect(shouldStartSurfacePan({ button: 2, pointerType: 'mouse' })).toBe(false)
  })

  it('leaves touch to native scrolling', () => {
    expect(shouldStartSurfacePan({ button: 0, pointerType: 'touch' })).toBe(false)
  })
})

describe('getPannedScrollOffsets', () => {
  it('moves the content with the pointer, so scroll goes the opposite way', () => {
    expect(getPannedScrollOffsets(origin, 250, 200)).toEqual({
      scrollLeft: 350,
      scrollTop: 250
    })
    expect(getPannedScrollOffsets(origin, 150, 100)).toEqual({
      scrollLeft: 450,
      scrollTop: 350
    })
  })

  it('is anchored to the press, not to the previous move', () => {
    const first = getPannedScrollOffsets(origin, 210, 160)
    const second = getPannedScrollOffsets(origin, 220, 170)

    expect(first).toEqual({ scrollLeft: 390, scrollTop: 290 })
    expect(second).toEqual({ scrollLeft: 380, scrollTop: 280 })
  })

  it('keeps the offsets unchanged when the pointer has not moved', () => {
    expect(getPannedScrollOffsets(origin, origin.clientX, origin.clientY)).toEqual({
      scrollLeft: origin.scrollLeft,
      scrollTop: origin.scrollTop
    })
  })
})
