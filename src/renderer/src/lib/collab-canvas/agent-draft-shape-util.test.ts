import { describe, expect, it } from 'vitest'
import { AGENT_DRAFT_SHAPE_TYPE, buildAgentDraftCreateShapePartial } from './agent-draft-shape'

describe('buildAgentDraftCreateShapePartial', () => {
  it('builds createShape args for a provisional agent-draft', () => {
    const { draft, shape } = buildAgentDraftCreateShapePartial({
      boardId: 'b1',
      body: 'Proposed fix for the login validation.',
      draftId: 'draft-1',
      placement: { x: 12, y: 34, w: 300, h: 120 }
    })
    expect(draft.typeName).toBe(AGENT_DRAFT_SHAPE_TYPE)
    expect(draft.status).toBe('provisional')
    expect(shape).toEqual({
      type: AGENT_DRAFT_SHAPE_TYPE,
      x: 12,
      y: 34,
      props: {
        w: 300,
        h: 120,
        draftId: 'draft-1',
        boardId: 'b1',
        body: 'Proposed fix for the login validation.',
        status: 'provisional',
        sourceTurnId: '',
        label: 'Agent draft',
        createdAt: draft.createdAt
      }
    })
  })
})
