import { describe, expect, it } from 'vitest'
import {
  clientToViewPoint,
  viewBoxUnitsPerPixel,
  zoomViewBox
} from './markdown-note-graph-viewport'

const fitted = { x: 0, y: 0, width: 800, height: 400 }

describe('zoomViewBox', () => {
  it('keeps the anchor point fixed while zooming', () => {
    const anchor = { x: 200, y: 100 }
    const zoomed = zoomViewBox(fitted, fitted, -1, anchor)
    expect(zoomed.width).toBeCloseTo(800 / 1.15)
    expect((anchor.x - zoomed.x) / zoomed.width).toBeCloseTo((anchor.x - fitted.x) / fitted.width)
  })

  it('clamps so repeated scrolling never collapses or explodes the view', () => {
    let box = fitted
    for (let i = 0; i < 500; i += 1) {
      box = zoomViewBox(box, fitted, -1, { x: 400, y: 200 })
    }
    expect(box.width).toBeCloseTo(800 / 20)
    for (let i = 0; i < 500; i += 1) {
      box = zoomViewBox(box, fitted, 1, { x: 400, y: 200 })
    }
    expect(box.width).toBeCloseTo(800 * 5)
  })

  it('ignores horizontal-only scrolling', () => {
    expect(zoomViewBox(fitted, fitted, 0, { x: 0, y: 0 })).toBe(fitted)
  })
})

describe('viewport mapping', () => {
  it('uses the larger axis scale, as `meet` does', () => {
    expect(viewBoxUnitsPerPixel(fitted, 1200, 500)).toBeCloseTo(0.8)
  })

  it('maps the centre of the element to the centre of the view', () => {
    const rect = { left: 10, top: 20, width: 1200, height: 500 }
    expect(clientToViewPoint(fitted, rect, 610, 270)).toEqual({ x: 400, y: 200 })
  })
})
