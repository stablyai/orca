import { describe, expect, it } from 'vitest'
import { arrowHeadGeometry, type MarkupPoint, type MarkupShape } from './markup-drawing-model'
import { shapesTouchedBySweep, topmostShapeAt } from './markup-shape-hit-test'

// Pinned here on purpose: how close the pointer must come is part of the behaviour.
const ERASER_RADIUS = 8

const base = { id: 's', color: '#ef4444' }
const noText = () => null

function touches(shape: MarkupShape, from: MarkupPoint, to: MarkupPoint = from): boolean {
  return shapesTouchedBySweep([shape], from, to, noText).length === 1
}

describe('shapesTouchedBySweep', () => {
  it('hits a pen stroke within its half-width plus the eraser radius, and not beyond', () => {
    const pen: MarkupShape = {
      ...base,
      kind: 'pen',
      width: 4,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 }
      ]
    }
    const reach = 2 + ERASER_RADIUS
    expect(touches(pen, { x: 50, y: reach })).toBe(true)
    expect(touches(pen, { x: 50, y: reach + 1 })).toBe(false)
    // Past the end of the stroke the round cap still counts.
    expect(touches(pen, { x: 100 + reach, y: 0 })).toBe(true)
    expect(touches(pen, { x: 100 + reach + 1, y: 0 })).toBe(false)
    // A sweep that passes the end without crossing the stroke or ending near it.
    expect(touches(pen, { x: 105, y: -50 }, { x: 105, y: 50 })).toBe(true)
    expect(touches(pen, { x: -5, y: -50 }, { x: -5, y: 50 })).toBe(true)
    // A drag that stops beside the stroke without crossing it.
    expect(touches(pen, { x: 50, y: -50 }, { x: 50, y: -reach })).toBe(true)
    expect(touches(pen, { x: 50, y: -50 }, { x: 50, y: -reach - 1 })).toBe(false)
  })

  it('hits a thin stroke that a fast drag crosses between two pointer events', () => {
    const pen: MarkupShape = {
      ...base,
      kind: 'pen',
      width: 2,
      points: [
        { x: 50, y: -100 },
        { x: 50, y: 100 }
      ]
    }
    expect(touches(pen, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(true)
    expect(touches(pen, { x: 0, y: 0 })).toBe(false)
    expect(touches(pen, { x: 100, y: 0 })).toBe(false)
  })

  it('hits the dot a single tap leaves', () => {
    const dot: MarkupShape = { ...base, kind: 'pen', width: 8, points: [{ x: 10, y: 10 }] }
    expect(touches(dot, { x: 10 + 4 + ERASER_RADIUS, y: 10 })).toBe(true)
    expect(touches(dot, { x: 10 + 4 + ERASER_RADIUS + 1, y: 10 })).toBe(false)
  })

  it('treats a highlight as the fat stroke it is drawn as', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 }
    ]
    const highlight: MarkupShape = { ...base, kind: 'highlight', width: 4, points }
    // A width-4 highlight is drawn 16px wide, so its ink reaches 8px from the centre line.
    const edge = { x: 50, y: 8 + ERASER_RADIUS }
    expect(touches(highlight, edge)).toBe(true)
    expect(touches(highlight, { x: 50, y: 8 + ERASER_RADIUS + 1 })).toBe(false)
    expect(touches({ ...base, kind: 'pen', width: 4, points }, edge)).toBe(false)
  })

  it('hits an arrow on its head wings as well as its shaft', () => {
    const from = { x: 0, y: 0 }
    const to = { x: 200, y: 0 }
    const arrow: MarkupShape = { ...base, kind: 'arrow', width: 8, from, to }
    const head = arrowHeadGeometry(from, to, 8)
    expect(head).not.toBeNull()
    // The wing tips sit well off the shaft, so only the head geometry can match them.
    for (const wing of head ? [head.left, head.right] : []) {
      expect(Math.abs(wing.y)).toBeGreaterThan(4 + ERASER_RADIUS)
      expect(touches(arrow, wing)).toBe(true)
    }
    expect(touches(arrow, { x: 100, y: 4 + ERASER_RADIUS })).toBe(true)
    expect(touches(arrow, { x: 100, y: 4 + ERASER_RADIUS + 1 })).toBe(false)
  })

  it('hits a rectangle on its border but not in its hollow interior', () => {
    const rect: MarkupShape = {
      ...base,
      kind: 'rect',
      width: 4,
      from: { x: 300, y: 200 },
      to: { x: 100, y: 100 }
    }
    expect(touches(rect, { x: 100 - 2 - ERASER_RADIUS, y: 150 })).toBe(true)
    expect(touches(rect, { x: 100 - 2 - ERASER_RADIUS - 1, y: 150 })).toBe(false)
    for (const onEdge of [
      { x: 200, y: 100 },
      { x: 300, y: 150 },
      { x: 200, y: 200 }
    ]) {
      expect(touches(rect, onEdge)).toBe(true)
    }
    expect(touches(rect, { x: 200, y: 150 })).toBe(false)
    expect(touches(rect, { x: 150, y: 150 }, { x: 250, y: 150 })).toBe(false)
  })

  it('hits a large ellipse anywhere on its outline but not inside it', () => {
    const ellipse: MarkupShape = {
      ...base,
      kind: 'ellipse',
      width: 2,
      from: { x: 200, y: 100 },
      to: { x: 1400, y: 700 }
    }
    const outline = (degrees: number, grow = 0): MarkupPoint => {
      const angle = (degrees * Math.PI) / 180
      return { x: 800 + (600 + grow) * Math.cos(angle), y: 400 + (300 + grow) * Math.sin(angle) }
    }
    // Odd angles on purpose: a coarse polygon approximation drifts furthest from
    // the true outline between its vertices.
    for (const degrees of [0, 11.25, 33.75, 101.25, 137, 222, 303.75]) {
      expect(touches(ellipse, outline(degrees))).toBe(true)
    }
    expect(touches(ellipse, outline(0, 1 + ERASER_RADIUS))).toBe(true)
    expect(touches(ellipse, outline(0, 1 + ERASER_RADIUS + 1))).toBe(false)
    expect(touches(ellipse, { x: 800, y: 400 })).toBe(false)
    expect(touches(ellipse, outline(0, -30))).toBe(false)
  })

  it('follows the curve of a small ellipse', () => {
    const circle: MarkupShape = {
      ...base,
      kind: 'ellipse',
      width: 2,
      from: { x: 0, y: 0 },
      to: { x: 20, y: 20 }
    }
    const reach = 1 + ERASER_RADIUS
    // 30 degrees is mid-side for the hexagon the chord limit alone would give this circle.
    const at = (radius: number): MarkupPoint => ({
      x: 10 + radius * Math.cos(Math.PI / 6),
      y: 10 + radius * Math.sin(Math.PI / 6)
    })
    expect(touches(circle, at(10 + reach - 0.5))).toBe(true)
    expect(touches(circle, at(10 + reach + 0.5))).toBe(false)
  })

  it('hits text anywhere in its measured ink box, including a sweep that ends inside it', () => {
    const text: MarkupShape = {
      ...base,
      kind: 'text',
      at: { x: 100, y: 100 },
      text: 'note',
      fontSize: 18
    }
    const box = () => ({ x: 98, y: 97, width: 60, height: 26 })
    const hit = (from: MarkupPoint, to: MarkupPoint = from) =>
      shapesTouchedBySweep([text], from, to, box).length === 1
    expect(hit({ x: 128, y: 110 })).toBe(true)
    expect(hit({ x: 0, y: 110 }, { x: 128, y: 110 })).toBe(true)
    expect(hit({ x: 98 + 60 + ERASER_RADIUS, y: 110 })).toBe(true)
    expect(hit({ x: 98 + 60 + ERASER_RADIUS + 1, y: 110 })).toBe(false)
    expect(hit({ x: 98 - ERASER_RADIUS - 1, y: 110 })).toBe(false)
    expect(hit({ x: 128, y: 97 - ERASER_RADIUS - 1 })).toBe(false)
    expect(hit({ x: 128, y: 97 + 26 + ERASER_RADIUS + 1 })).toBe(false)
    // Without a canvas to measure on there is no drawn ink to hit.
    expect(touches(text, { x: 128, y: 110 })).toBe(false)
  })

  it('returns every touched shape, not only the topmost', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 }
    ]
    const shapes: MarkupShape[] = [
      { id: 'under', color: '#eab308', kind: 'highlight', width: 4, points },
      { id: 'over', color: '#ef4444', kind: 'pen', width: 2, points },
      { id: 'away', color: '#ef4444', kind: 'pen', width: 2, points: [{ x: 0, y: 300 }] }
    ]
    const ids = shapesTouchedBySweep(shapes, { x: 50, y: 0 }, { x: 50, y: 0 }, noText).map(
      (shape) => shape.id
    )
    expect(ids).toEqual(['under', 'over'])
  })
})

describe('topmostShapeAt', () => {
  it('returns the mark drawn last among those under the point', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 }
    ]
    const shapes: MarkupShape[] = [
      { id: 'under', color: '#eab308', kind: 'highlight', width: 4, points },
      { id: 'over', color: '#ef4444', kind: 'pen', width: 2, points },
      { id: 'away', color: '#ef4444', kind: 'pen', width: 2, points: [{ x: 0, y: 300 }] }
    ]
    expect(topmostShapeAt(shapes, { x: 50, y: 0 }, noText)?.id).toBe('over')
    expect(topmostShapeAt(shapes, { x: 50, y: 150 }, noText)).toBeUndefined()
  })
})
