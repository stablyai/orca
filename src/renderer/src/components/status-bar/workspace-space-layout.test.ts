import { describe, expect, it } from 'vitest'
import { buildTreemapLayout } from './workspace-space-layout'

describe('buildTreemapLayout', () => {
  it('lays out positive-size items inside a 100x100 treemap', () => {
    const rects = buildTreemapLayout([
      { id: 'a', label: 'A', sizeBytes: 60 },
      { id: 'b', label: 'B', sizeBytes: 30 },
      { id: 'c', label: 'C', sizeBytes: 10 },
      { id: 'empty', label: 'Empty', sizeBytes: 0 }
    ])

    expect(rects.map((rect) => rect.id)).toEqual(['a', 'b', 'c'])
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.width).toBeLessThanOrEqual(100)
      expect(rect.y + rect.height).toBeLessThanOrEqual(100)
    }
    const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0)
    expect(area).toBeCloseTo(10_000, 5)
    expect(rects[0].width * rects[0].height).toBeGreaterThan(rects[1].width * rects[1].height)
  })
})
