import { describe, expect, it } from 'vitest'
import {
  type PanZoomPoint,
  type PanZoomView,
  clampPanZoom,
  getPanZoomFitScale,
  getPanZoomViewOffset,
  getFittedPanZoomView,
  panView,
  zoomViewAt
} from './pan-zoom-view'

const viewport = { width: 1000, height: 600 }

function pointAt(view: PanZoomView, anchor: PanZoomPoint, scale: number): PanZoomPoint {
  const offset = getPanZoomViewOffset(view, viewport, scale)
  return { x: (anchor.x - offset.x) / scale, y: (anchor.y - offset.y) / scale }
}

describe('pan and zoom view', () => {
  it('shrinks huge content to fit and never enlarges small content', () => {
    expect(getPanZoomFitScale({ width: 10_000, height: 500 }, viewport, 0)).toBeCloseTo(0.1)
    expect(getPanZoomFitScale({ width: 200, height: 100 }, viewport, 0)).toBe(1)
  })

  it('centers the fitted content in the viewport', () => {
    const content = { width: 400, height: 200 }
    expect(getPanZoomViewOffset(getFittedPanZoomView(content), viewport, 1)).toEqual({
      x: 300,
      y: 200
    })
  })

  it('lets content fitted far below natural size zoom back up to it', () => {
    expect(clampPanZoom(100, 0.05)).toBe(20)
    expect(clampPanZoom(100, 0.5)).toBe(8)
    expect(clampPanZoom(0.01, 0.5)).toBe(0.25)
  })

  it('keeps the point under the cursor in place while zooming', () => {
    const content = { width: 2000, height: 1200 }
    const fitScale = 0.5
    const view = getFittedPanZoomView(content)
    const anchor = { x: 180, y: 420 }
    const zoomed = zoomViewAt({
      view,
      nextZoom: 3,
      anchor,
      viewport,
      fitScale,
      content
    })

    const before = pointAt(view, anchor, fitScale)
    const after = pointAt(zoomed, anchor, fitScale * 3)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('moves the content with the pointer and stops at its edges', () => {
    const content = { width: 400, height: 200 }
    const view = getFittedPanZoomView(content)
    expect(panView(view, { x: 50, y: -20 }, 2, content).center).toEqual({
      x: 175,
      y: 110
    })
    expect(panView(view, { x: -9999, y: 9999 }, 2, content).center).toEqual({
      x: 400,
      y: 0
    })
  })
})
