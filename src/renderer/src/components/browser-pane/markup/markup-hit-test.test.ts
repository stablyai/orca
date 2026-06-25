import { describe, expect, it } from 'vitest'
import { findTopShape, hitTestShape, pointToSegmentDistance } from './markup-hit-test'
import type {
  ArrowShape,
  HighlightShape,
  MarkupShape,
  PenShape,
  RectShape,
  TextShape
} from './markup-drawing-model'

describe('pointToSegmentDistance', () => {
  it('measures distance to the nearest point on a segment', () => {
    expect(pointToSegmentDistance({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5)
    expect(pointToSegmentDistance({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5)
  })

  it('handles a degenerate (zero-length) segment', () => {
    expect(pointToSegmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5)
  })
})

describe('hitTestShape', () => {
  const arrow: ArrowShape = {
    id: 'a',
    kind: 'arrow',
    color: '#fff',
    width: 4,
    from: { x: 0, y: 0 },
    to: { x: 100, y: 0 }
  }

  it('hits near a thin line within tolerance, misses when far', () => {
    expect(hitTestShape(arrow, { x: 50, y: 2 }, 4)).toBe(true)
    expect(hitTestShape(arrow, { x: 50, y: 40 }, 4)).toBe(false)
  })

  it('selects a rectangle by clicking inside its bounds', () => {
    const rect: RectShape = {
      id: 'r',
      kind: 'rect',
      color: '#fff',
      width: 2,
      from: { x: 0, y: 0 },
      to: { x: 40, y: 40 }
    }
    expect(hitTestShape(rect, { x: 20, y: 20 }, 2)).toBe(true)
    expect(hitTestShape(rect, { x: 80, y: 80 }, 2)).toBe(false)
  })

  it('hit-tests highlights against their rendered (fat) thickness, not the raw width', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 100, y: 0 }
    ]
    const highlight: HighlightShape = {
      id: 'h',
      kind: 'highlight',
      color: '#ff0',
      width: 4,
      points: line
    }
    const pen: PenShape = { id: 'p', kind: 'pen', color: '#ff0', width: 4, points: line }
    // 6px off the line: inside the fat highlight band (4*4/2 = 8) but outside the
    // thin pen (4/2 = 2), each with a small tolerance.
    expect(hitTestShape(highlight, { x: 50, y: 6 }, 1)).toBe(true)
    expect(hitTestShape(pen, { x: 50, y: 6 }, 1)).toBe(false)
  })

  it('hits within a text bounding box', () => {
    const text: TextShape = {
      id: 't',
      kind: 'text',
      color: '#fff',
      at: { x: 10, y: 10 },
      text: 'hello',
      fontSize: 20
    }
    expect(hitTestShape(text, { x: 12, y: 14 }, 2)).toBe(true)
  })
})

describe('findTopShape', () => {
  it('returns the last (topmost) overlapping shape', () => {
    const a: RectShape = {
      id: 'a',
      kind: 'rect',
      color: '#fff',
      width: 2,
      from: { x: 0, y: 0 },
      to: { x: 50, y: 50 }
    }
    const b: RectShape = { ...a, id: 'b' }
    const shapes: MarkupShape[] = [a, b]
    expect(findTopShape(shapes, { x: 25, y: 25 }, 2)?.id).toBe('b')
    expect(findTopShape(shapes, { x: 500, y: 500 }, 2)).toBeNull()
  })
})
