/**
 * Regression: agent-draft must be registered on the multiplayer store schema
 * (useSync shapeUtils), not only on <Tldraw shapeUtils>. Otherwise Store.put
 * throws ValidationError when auto-draft / mountAgentDraftOnEditor runs.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_DRAFT_SHAPE_TYPE } from './agent-draft-shape'
import { COLLAB_CANVAS_SHAPE_UTILS, AgentDraftShapeUtil } from './agent-draft-shape-util'

describe('agent-draft store schema registration', () => {
  it('exports AgentDraftShapeUtil in COLLAB_CANVAS_SHAPE_UTILS for useSync', () => {
    expect(COLLAB_CANVAS_SHAPE_UTILS).toContain(AgentDraftShapeUtil)
    expect(AgentDraftShapeUtil.type).toBe(AGENT_DRAFT_SHAPE_TYPE)
    expect(AgentDraftShapeUtil.props).toBeDefined()
  })

  it('AgentDraftShapeUtil declares required props for validation', () => {
    const props = AgentDraftShapeUtil.props
    expect(props).toHaveProperty('body')
    expect(props).toHaveProperty('draftId')
    expect(props).toHaveProperty('boardId')
    expect(props).toHaveProperty('status')
  })
})
