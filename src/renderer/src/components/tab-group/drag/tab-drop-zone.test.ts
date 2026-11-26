import { describe, expect, it } from 'vitest'
import { resolvePaneColumnEdgeZone } from './tab-drop-zone'

describe('resolvePaneColumnEdgeZone', () => {
  // A 1000px panel whose 240px vertical tab list sits left of a 760px body, below a 32px row.
  const panel = { left: 0, top: 0, width: 1000, height: 600 }
  const body = { left: 240, top: 32, width: 760, height: 568 }

  it("measures side edges from the body, so the list never eats the body's left edge", () => {
    expect(resolvePaneColumnEdgeZone(panel, { x: 300, y: 300 }, { bodyRect: body })).toBe('left')
    expect(resolvePaneColumnEdgeZone(panel, { x: 600, y: 300 }, { bodyRect: body })).toBeNull()
    expect(resolvePaneColumnEdgeZone(panel, { x: 900, y: 300 }, { bodyRect: body })).toBe('right')
  })
})
