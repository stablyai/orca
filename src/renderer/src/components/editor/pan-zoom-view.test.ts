import { describe, expect, it } from 'vitest'
import {
  type PanZoomPoint,
  type PanZoomView,
  getPanZoomViewOffset,
  getFittedPanZoomView,
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
})
