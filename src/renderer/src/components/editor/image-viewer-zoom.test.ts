import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_VIEWER_ZOOM,
  MIN_IMAGE_VIEWER_ZOOM,
  clampImageViewerZoom,
  getAnchoredImageViewerScrollOffset,
  getNextWheelImageViewerZoom,
  getPinchZoomFactor,
  getZoomedImageLayoutSize,
  shouldHandleImageZoomWheel
} from './image-viewer-zoom'

describe('image viewer zoom helpers', () => {
  it('clamps zoom to the viewer bounds', () => {
    expect(clampImageViewerZoom(0.01)).toBe(MIN_IMAGE_VIEWER_ZOOM)
    expect(clampImageViewerZoom(1)).toBe(1)
    expect(clampImageViewerZoom(20)).toBe(MAX_IMAGE_VIEWER_ZOOM)
  })

  it('handles only ctrl-wheel input as image zoom', () => {
    expect(shouldHandleImageZoomWheel({ ctrlKey: true })).toBe(true)
    expect(shouldHandleImageZoomWheel({ ctrlKey: false })).toBe(false)
  })

  it('maps negative wheel deltas to zoom in and positive deltas to zoom out', () => {
    expect(getNextWheelImageViewerZoom(1, -30, 0)).toBeGreaterThan(1)
    expect(getNextWheelImageViewerZoom(1, 30, 0)).toBeLessThan(1)
  })

  it('keeps zero wheel delta from changing zoom while still being handleable', () => {
    expect(getPinchZoomFactor(0, 0)).toBe(1)
    expect(getNextWheelImageViewerZoom(1.5, 0, 0)).toBe(1.5)
    expect(shouldHandleImageZoomWheel({ ctrlKey: true })).toBe(true)
  })

  it('normalizes line and page wheel delta modes', () => {
    const pixelFactor = getPinchZoomFactor(1, 0)
    const lineFactor = getPinchZoomFactor(1, 1)
    const pageFactor = getPinchZoomFactor(1, 2)

    expect(lineFactor).toBeLessThan(pixelFactor)
    expect(pageFactor).toBeLessThan(lineFactor)
  })

  it('bounds very large per-event zoom factors', () => {
    expect(getPinchZoomFactor(-10_000, 0)).toBeCloseTo(getPinchZoomFactor(-200, 0))
    expect(getPinchZoomFactor(10_000, 0)).toBeCloseTo(getPinchZoomFactor(200, 0))
    expect(getPinchZoomFactor(-10_000, 0)).toBeLessThan(2)
    expect(getPinchZoomFactor(10_000, 0)).toBeGreaterThan(0.5)
  })

  it('stays clamped at min and max zoom for pinch gestures', () => {
    expect(getNextWheelImageViewerZoom(MIN_IMAGE_VIEWER_ZOOM, 100, 0)).toBe(MIN_IMAGE_VIEWER_ZOOM)
    expect(getNextWheelImageViewerZoom(MAX_IMAGE_VIEWER_ZOOM, -100, 0)).toBe(MAX_IMAGE_VIEWER_ZOOM)
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

  it('does not upscale images at 100 percent before applying user zoom', () => {
    expect(
      getZoomedImageLayoutSize({
        imageDimensions: { width: 200, height: 100 },
        surfaceSize: { width: 800, height: 600 },
        zoom: 1
      })
    ).toEqual({ width: 200, height: 100 })
    expect(
      getZoomedImageLayoutSize({
        imageDimensions: { width: 200, height: 100 },
        surfaceSize: { width: 800, height: 600 },
        zoom: 2
      })
    ).toEqual({ width: 400, height: 200 })
  })

  it('returns no layout size until image and surface dimensions are available', () => {
    expect(
      getZoomedImageLayoutSize({
        imageDimensions: null,
        surfaceSize: { width: 800, height: 600 },
        zoom: 1
      })
    ).toBeNull()
    expect(
      getZoomedImageLayoutSize({
        imageDimensions: { width: 200, height: 100 },
        surfaceSize: null,
        zoom: 1
      })
    ).toBeNull()
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

  it('leaves scroll unchanged when the current zoom is invalid', () => {
    expect(
      getAnchoredImageViewerScrollOffset({
        scrollOffset: 100,
        anchorOffset: 200,
        currentZoom: 0,
        nextZoom: 2
      })
    ).toBe(100)
  })
})
