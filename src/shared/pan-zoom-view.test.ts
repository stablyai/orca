import { describe, expect, it } from 'vitest'
import {
  type PanZoomPoint,
  type PanZoomView,
  clampPanZoom,
  containPanZoomView,
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

  it('carries the content under a pinch to where the fingers moved', () => {
    const content = { width: 2000, height: 1200 }
    const fitScale = 0.5
    const view = { zoom: 2, center: { x: 1000, y: 600 } }
    const anchor = { x: 400, y: 300 }
    const target = { x: 340, y: 320 }
    const zoomed = zoomViewAt({ view, nextZoom: 3, anchor, target, viewport, fitScale, content })

    const before = pointAt(view, anchor, fitScale * 2)
    const after = pointAt(zoomed, target, fitScale * 3)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('lets an icon fitted far above its natural size zoom back out to actual size', () => {
    const fitScale = 32
    expect(clampPanZoom(1 / fitScale, fitScale) * fitScale).toBe(1)
  })

  it('pulls a view panned to an edge back inside after the viewport resizes', () => {
    const content = { width: 4000, height: 3000 }
    const portrait = { width: 390, height: 700 }
    const landscape = { width: 700, height: 390 }
    // Actual size in portrait, panned to the right edge.
    const atEdge = { zoom: 4000 / 390, center: { x: 4000 - 390 / 2, y: 1500 } }
    const fitScale = 390 / 4000
    const contained = containPanZoomView(atEdge, { content, viewport: landscape, fitScale })

    expect(contained.center.x).toBeCloseTo(4000 - 700 / 2)
    expect(containPanZoomView(atEdge, { content, viewport: portrait, fitScale })).toEqual(atEdge)
  })

  it('keeps contained content centered while it fits and stops it at its edges once zoomed', () => {
    const content = { width: 500, height: 300 }
    const fitted = getFittedPanZoomView(content)
    expect(panView(fitted, { x: 200, y: 80 }, 1, content, viewport)).toEqual(fitted)

    const zoomed = { zoom: 4, center: fitted.center }
    expect(panView(zoomed, { x: 5000, y: -5000 }, 4, content, viewport).center).toEqual({
      x: 125,
      y: 225
    })
  })
})
