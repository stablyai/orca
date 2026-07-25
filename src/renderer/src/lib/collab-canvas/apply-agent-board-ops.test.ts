import { describe, expect, it, vi } from 'vitest'
import { applyAgentBoardOps } from './apply-agent-board-ops'

describe('applyAgentBoardOps', () => {
  it('creates geo, note, and draft shapes', () => {
    const createShape = vi.fn()
    const result = applyAgentBoardOps(
      { createShape },
      'board-1',
      [
        { op: 'geo', geo: 'rectangle', x: 10, y: 20, w: 100, h: 50, label: 'A' },
        { op: 'note', x: 10, y: 90, text: 'hello' },
        { op: 'draft', body: 'next step', x: 200, y: 20 }
      ]
    )
    expect(result).toEqual({ applied: 3, drafts: 1, geos: 1, notes: 1 })
    expect(createShape).toHaveBeenCalled()
    const types = createShape.mock.calls.map((c) => c[0].type)
    expect(types).toContain('geo')
    expect(types).toContain('note')
    expect(types).toContain('agent-draft')
  })
})
