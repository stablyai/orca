import { describe, expect, it } from 'vitest'
import { getPinchZoomFactor } from './image-viewer-zoom'

describe('image viewer zoom helpers', () => {
  it('normalizes line and page wheel delta modes', () => {
    const pixelFactor = getPinchZoomFactor(1, 0)
    const lineFactor = getPinchZoomFactor(1, 1)
    const pageFactor = getPinchZoomFactor(1, 2)

    expect(lineFactor).toBeLessThan(pixelFactor)
    expect(pageFactor).toBeLessThan(lineFactor)
  })

  it('bounds very large per-event zoom factors', () => {
    expect(getPinchZoomFactor(-10_000, 0)).toBeCloseTo(getPinchZoomFactor(-100, 0))
    expect(getPinchZoomFactor(10_000, 0)).toBeCloseTo(getPinchZoomFactor(100, 0))
    expect(getPinchZoomFactor(-10_000, 0)).toBeLessThan(2)
    expect(getPinchZoomFactor(10_000, 0)).toBeGreaterThan(0.5)
  })
})
