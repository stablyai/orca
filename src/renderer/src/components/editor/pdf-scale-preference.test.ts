import { describe, expect, it, vi } from 'vitest'
import {
  applyPdfScalePreference,
  clampPdfScale,
  stepPdfScalePreference,
  zoomPdfViewerWithWheel
} from './pdf-scale-preference'
import { getPinchZoomFactor } from './image-viewer-zoom'

const BOUNDS = { min: 0.25, max: 5, step: 1.25 }

describe('clampPdfScale', () => {
  it('clamps to the configured range', () => {
    expect(clampPdfScale(0.1, BOUNDS.min, BOUNDS.max)).toBe(0.25)
    expect(clampPdfScale(9, BOUNDS.min, BOUNDS.max)).toBe(5)
    expect(clampPdfScale(1.5, BOUNDS.min, BOUNDS.max)).toBe(1.5)
  })
})

describe('applyPdfScalePreference', () => {
  it('restores an absolute scale after a content reload', () => {
    const viewer = { currentScale: 1, currentScaleValue: 'auto' }
    applyPdfScalePreference(viewer, 2.5, BOUNDS)
    expect(viewer.currentScale).toBe(2.5)
  })

  it('uses fit-to-width for the default preference', () => {
    const viewer = { currentScale: 1, currentScaleValue: 'auto' }
    applyPdfScalePreference(viewer, 'page-width', BOUNDS)
    expect(viewer.currentScaleValue).toBe('page-width')
  })

  it('clamps an out-of-range absolute preference', () => {
    const viewer = { currentScale: 1, currentScaleValue: 'auto' }
    applyPdfScalePreference(viewer, 99, BOUNDS)
    expect(viewer.currentScale).toBe(5)
  })
})

describe('stepPdfScalePreference', () => {
  it('records the absolute scale so a later reload can restore it', () => {
    const zoomedIn = stepPdfScalePreference(1, 'in', BOUNDS)
    expect(zoomedIn.preference).toBe(1.25)
    expect(zoomedIn.scale).toBe(1.25)

    const zoomedOut = stepPdfScalePreference(1.25, 'out', BOUNDS)
    expect(zoomedOut.preference).toBe(1)
    expect(zoomedOut.scale).toBe(1)
  })
})

describe('zoomPdfViewerWithWheel', () => {
  function wheel(deltaY: number, ctrlKey = true) {
    return { ctrlKey, deltaY, deltaMode: 0, clientX: 300, clientY: 250, preventDefault: vi.fn() }
  }
  function viewerAt(scale: number) {
    return {
      currentScale: scale,
      container: {
        scrollLeft: 100,
        scrollTop: 400,
        getBoundingClientRect: () => ({ left: 200, top: 50 })
      },
      update: vi.fn()
    }
  }

  it('leaves plain wheel scrolling alone', () => {
    const viewer = viewerAt(1)
    const event = wheel(-30, false)
    expect(zoomPdfViewerWithWheel(viewer, event, BOUNDS)).toBeNull()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(viewer.currentScale).toBe(1)
  })

  it('keeps the content under the pointer in place', () => {
    const viewer = viewerAt(1)
    const event = wheel(-30)
    expect(zoomPdfViewerWithWheel(viewer, event, BOUNDS)).toBe(viewer.currentScale)
    expect(event.preventDefault).toHaveBeenCalled()
    const growth = viewer.currentScale - 1
    expect(growth).toBeGreaterThan(0)
    // Pointer sits 100px right of and 200px below the container's top-left.
    expect(viewer.container.scrollLeft).toBeCloseTo(100 + 100 * growth)
    expect(viewer.container.scrollTop).toBeCloseTo(400 + 200 * growth)
    // The next same-frame event must anchor to this scroll position.
    expect(viewer.update).toHaveBeenCalledOnce()
  })

  it('accumulates slow trackpad pinches instead of rounding them away', () => {
    const viewer = viewerAt(0.5)
    for (let i = 0; i < 30; i++) {
      zoomPdfViewerWithWheel(viewer, wheel(-1), BOUNDS)
    }
    expect(viewer.currentScale).toBeCloseTo(0.5 * getPinchZoomFactor(-1, 0) ** 30)
  })

  it('claims the gesture but stops at the scale bounds', () => {
    const viewer = viewerAt(BOUNDS.max)
    const event = wheel(-30)
    expect(zoomPdfViewerWithWheel(viewer, event, BOUNDS)).toBeNull()
    expect(event.preventDefault).toHaveBeenCalled()
    expect(viewer.container.scrollLeft).toBe(100)
    expect(viewer.update).not.toHaveBeenCalled()
  })
})
