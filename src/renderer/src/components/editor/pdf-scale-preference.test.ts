import { describe, expect, it } from 'vitest'
import { zoomPdfViewerWithWheel } from './pdf-scale-preference'

function fakeViewer(currentScale: number) {
  return {
    currentScale,
    currentScaleValue: '',
    container: { scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    update: () => {}
  }
}

const zoomInEvent = {
  ctrlKey: true,
  deltaY: -100,
  deltaMode: 0,
  clientX: 0,
  clientY: 0,
  preventDefault: () => {}
}
const bounds = { min: 0.25, max: 5 }

describe('zoomPdfViewerWithWheel', () => {
  it('stops on the fit-width scale when a step would pass it, then leaves it', () => {
    const below = fakeViewer(1)
    expect(zoomPdfViewerWithWheel(below, zoomInEvent, bounds, () => 1.5)).toBe('page-width')
    expect(below.currentScaleValue).toBe('page-width')

    const atFit = fakeViewer(1.5)
    expect(zoomPdfViewerWithWheel(atFit, zoomInEvent, bounds, () => 1.5)).toBeGreaterThan(1.5)
  })
})
