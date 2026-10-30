import { describe, expect, it } from 'vitest'
import {
  getAnchoredImageViewerScrollOffset,
  getPinchZoomFactor,
  getZoomedImageLayoutSize
} from './image-viewer-zoom'

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

  it('uses fitted image dimensions as the base layout size before zooming', () => {
    expect(
      getZoomedImageLayoutSize({
        imageDimensions: { width: 1000, height: 500 },
        surfaceSize: { width: 500, height: 500 },
        zoom: 1
      })
    ).toEqual({ width: 468, height: 234 })
    expect(
      getZoomedImageLayoutSize({
        imageDimensions: { width: 1000, height: 500 },
        surfaceSize: { width: 500, height: 500 },
        zoom: 2
      })
    ).toEqual({ width: 936, height: 468 })
  })

  it('keeps the zoom anchor stable by moving the scroll offset', () => {
    expect(
      getAnchoredImageViewerScrollOffset({
        scrollOffset: 100,
        anchorOffset: 200,
        currentZoom: 1,
        nextZoom: 2
      })
    ).toBe(400)
    expect(
      getAnchoredImageViewerScrollOffset({
        scrollOffset: 400,
        anchorOffset: 200,
        currentZoom: 2,
        nextZoom: 1
      })
    ).toBe(100)
  })
})
