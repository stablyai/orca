import { describe, expect, it } from 'vitest'
import {
  AGENT_DRAFT_SHAPE_TYPE,
  defaultAgentDraftProps,
  isAgentDraftRecord
} from './agent-draft-shape'

describe('agent-draft shape helpers', () => {
  it('uses the stable type id agent-draft', () => {
    expect(AGENT_DRAFT_SHAPE_TYPE).toBe('agent-draft')
  })

  it('builds default props via the shipped bridge entry point', () => {
    const props = defaultAgentDraftProps({ boardId: 'b1', body: 'hello draft' })
    expect(props.typeName).toBe(AGENT_DRAFT_SHAPE_TYPE)
    expect(props.status).toBe('provisional')
    expect(props.visual.strokeStyle).toBe('dashed')
    expect(props.body).toBe('hello draft')
  })

  it('detects agent-draft records and rejects freehand types', () => {
    expect(isAgentDraftRecord({ type: 'agent-draft' })).toBe(true)
    expect(isAgentDraftRecord({ typeName: 'agent-draft' })).toBe(true)
    expect(isAgentDraftRecord({ type: 'draw' })).toBe(false)
    expect(isAgentDraftRecord({ type: 'geo' })).toBe(false)
    expect(isAgentDraftRecord(null)).toBe(false)
  })
})
