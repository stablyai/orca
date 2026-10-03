import { describe, expect, it } from 'vitest'
import {
  DIAGRAM_BUTTON_ZOOM_STEP,
  DIAGRAM_KEY_PAN_STEP,
  MAX_DIAGRAM_SCALE,
  MIN_DIAGRAM_SCALE,
  clampDiagramScale,
  diagramKeyAction,
  diagramMinScale,
  fitDiagramTransform,
  isSameDiagramTransform,
  wheelZoomFactor,
  zoomDiagramAt
} from './mermaid-diagram-viewport'

describe('fitDiagramTransform', () => {
  it('scales a wide diagram down to the viewport width and centers it vertically', () => {
    const t = fitDiagramTransform({ width: 3000, height: 1000 }, { width: 1064, height: 800 })
    expect(t.scale).toBeCloseTo(1000 / 3000)
    expect(t.x).toBeCloseTo(32)
    expect(t.y).toBeCloseTo((800 - 1000 * t.scale) / 2)
  })

  it('caps the upscale for small diagrams', () => {
    const t = fitDiagramTransform({ width: 100, height: 50 }, { width: 2000, height: 1000 })
    expect(t.scale).toBe(2)
    expect(t.x).toBe((2000 - 200) / 2)
  })

  it('fits diagrams that need less than the default minimum scale', () => {
    const t = fitDiagramTransform({ width: 20000, height: 1000 }, { width: 1064, height: 800 })
    expect(t.scale).toBeCloseTo(1000 / 20000)
    expect(t.scale).toBeLessThan(MIN_DIAGRAM_SCALE)
    expect(t.x + 20000 * t.scale).toBeCloseTo(1064 - 32)
  })

  it('falls back to identity when sizes are unknown', () => {
    expect(fitDiagramTransform({ width: 0, height: 0 }, { width: 800, height: 600 })).toEqual({
      x: 0,
      y: 0,
      scale: 1
    })
  })
})

describe('zoomDiagramAt', () => {
  it('keeps the diagram point under the anchor fixed', () => {
    const start = { x: 40, y: 20, scale: 1 }
    const anchor = { x: 240, y: 170 }
    const diagramPointBefore = {
      x: (anchor.x - start.x) / start.scale,
      y: (anchor.y - start.y) / start.scale
    }
    const next = zoomDiagramAt(start, 2.5, anchor)
    expect(next.scale).toBe(2.5)
    expect(next.x + diagramPointBefore.x * next.scale).toBeCloseTo(anchor.x)
    expect(next.y + diagramPointBefore.y * next.scale).toBeCloseTo(anchor.y)
  })

  it('clamps to the supported scale range without drifting the anchor', () => {
    const start = { x: 0, y: 0, scale: MAX_DIAGRAM_SCALE }
    expect(zoomDiagramAt(start, 100, { x: 300, y: 300 })).toEqual(start)
    expect(clampDiagramScale(0.001)).toBe(MIN_DIAGRAM_SCALE)
  })
})

describe('diagramMinScale', () => {
  it('lets zoom-out reach the fit scale of a huge diagram without going lower', () => {
    const fitScale = 0.05
    const minScale = diagramMinScale(fitScale)
    expect(minScale).toBe(fitScale)
    const zoomedOut = zoomDiagramAt({ x: 0, y: 0, scale: 0.2 }, 0.001, { x: 0, y: 0 }, minScale)
    expect(zoomedOut.scale).toBe(fitScale)
  })

  it('keeps the default floor for diagrams that fit above it', () => {
    expect(diagramMinScale(0.6)).toBe(MIN_DIAGRAM_SCALE)
  })
})

describe('isSameDiagramTransform', () => {
  it('reports no change for a zoom that is already at the scale limit', () => {
    const atMax = { x: 10, y: 20, scale: MAX_DIAGRAM_SCALE }
    expect(isSameDiagramTransform(atMax, zoomDiagramAt(atMax, 100, { x: 50, y: 50 }))).toBe(true)
  })

  it('reports no change for a zero wheel delta and a change for a real zoom', () => {
    const start = { x: 10, y: 20, scale: 1 }
    const anchor = { x: 50, y: 50 }
    expect(isSameDiagramTransform(start, zoomDiagramAt(start, wheelZoomFactor(0, 0), anchor))).toBe(
      true
    )
    expect(
      isSameDiagramTransform(start, zoomDiagramAt(start, wheelZoomFactor(-100, 0), anchor))
    ).toBe(false)
  })
})

describe('wheelZoomFactor', () => {
  it('zooms in on upward scroll and out on downward scroll', () => {
    expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100, 0)).toBeLessThan(1)
    expect(wheelZoomFactor(100, 0) * wheelZoomFactor(-100, 0)).toBeCloseTo(1)
  })

  it('treats line-mode deltas as larger pixel deltas', () => {
    expect(wheelZoomFactor(3, 1)).toBeCloseTo(wheelZoomFactor(48, 0))
  })

  it('treats page-mode deltas as a full page of pixels', () => {
    expect(wheelZoomFactor(1, 2)).toBeCloseTo(wheelZoomFactor(800, 0))
    expect(wheelZoomFactor(1, 2)).toBeLessThan(0.5)
  })
})

describe('diagramKeyAction', () => {
  it('pans like scrolling: ArrowRight reveals content to the right', () => {
    expect(diagramKeyAction('ArrowRight', false)).toEqual({
      kind: 'pan',
      dx: -DIAGRAM_KEY_PAN_STEP,
      dy: 0
    })
    expect(diagramKeyAction('ArrowUp', false)).toEqual({
      kind: 'pan',
      dx: 0,
      dy: DIAGRAM_KEY_PAN_STEP
    })
  })

  it('pans in bigger steps with Shift', () => {
    const slow = diagramKeyAction('ArrowDown', false)
    const fast = diagramKeyAction('ArrowDown', true)
    expect(slow?.kind === 'pan' && fast?.kind === 'pan' && fast.dy / slow.dy).toBe(4)
  })

  it('zooms with + / = and -, and fits with 0', () => {
    expect(diagramKeyAction('+', true)).toEqual({ kind: 'zoom', factor: DIAGRAM_BUTTON_ZOOM_STEP })
    expect(diagramKeyAction('=', false)).toEqual({ kind: 'zoom', factor: DIAGRAM_BUTTON_ZOOM_STEP })
    expect(diagramKeyAction('-', false)).toEqual({
      kind: 'zoom',
      factor: 1 / DIAGRAM_BUTTON_ZOOM_STEP
    })
    expect(diagramKeyAction('0', false)).toEqual({ kind: 'fit' })
  })

  it('ignores unrelated keys so Escape and Tab keep their dialog behavior', () => {
    expect(diagramKeyAction('Escape', false)).toBeNull()
    expect(diagramKeyAction('Tab', false)).toBeNull()
    expect(diagramKeyAction('a', false)).toBeNull()
  })
})
