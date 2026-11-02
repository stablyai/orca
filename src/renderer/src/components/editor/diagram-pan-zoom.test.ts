import { describe, expect, it } from 'vitest'
import {
  type DiagramPoint,
  type DiagramView,
  clampDiagramZoom,
  getDiagramFitScale,
  getDiagramViewOffset,
  getFittedDiagramView,
  panDiagramView,
  zoomDiagramViewAt
} from './diagram-pan-zoom'

const viewport = { width: 1000, height: 600 }

function pointAt(view: DiagramView, anchor: DiagramPoint, scale: number): DiagramPoint {
  const offset = getDiagramViewOffset(view, viewport, scale)
  return { x: (anchor.x - offset.x) / scale, y: (anchor.y - offset.y) / scale }
}

describe('diagram pan and zoom', () => {
  it('shrinks a huge diagram to fit and never enlarges a small one', () => {
    expect(getDiagramFitScale({ width: 10_000, height: 500 }, viewport, 0)).toBeCloseTo(0.1)
    expect(getDiagramFitScale({ width: 200, height: 100 }, viewport, 0)).toBe(1)
  })

  it('centers the fitted diagram in the viewport', () => {
    const diagram = { width: 400, height: 200 }
    expect(getDiagramViewOffset(getFittedDiagramView(diagram), viewport, 1)).toEqual({
      x: 300,
      y: 200
    })
  })

  it('lets a diagram fitted far below natural size zoom back up to it', () => {
    expect(clampDiagramZoom(100, 0.05)).toBe(20)
    expect(clampDiagramZoom(100, 0.5)).toBe(8)
    expect(clampDiagramZoom(0.01, 0.5)).toBe(0.25)
  })

  it('keeps the point under the cursor in place while zooming', () => {
    const diagram = { width: 2000, height: 1200 }
    const fitScale = 0.5
    const view = getFittedDiagramView(diagram)
    const anchor = { x: 180, y: 420 }
    const zoomed = zoomDiagramViewAt({ view, nextZoom: 3, anchor, viewport, fitScale, diagram })

    const before = pointAt(view, anchor, fitScale)
    const after = pointAt(zoomed, anchor, fitScale * 3)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('moves the diagram with the pointer and stops at its edges', () => {
    const diagram = { width: 400, height: 200 }
    const view = getFittedDiagramView(diagram)
    expect(panDiagramView(view, { x: 50, y: -20 }, 2, diagram).center).toEqual({ x: 175, y: 110 })
    expect(panDiagramView(view, { x: -9999, y: 9999 }, 2, diagram).center).toEqual({ x: 400, y: 0 })
  })
})
