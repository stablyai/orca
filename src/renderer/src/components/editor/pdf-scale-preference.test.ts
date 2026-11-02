import { describe, expect, it, vi } from 'vitest'
import { zoomPdfViewerWithWheel } from './pdf-scale-preference'

import { getPinchZoomFactor } from './image-viewer-zoom'

const BOUNDS = { min: 0.25, max: 5, step: 1.25 }

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
