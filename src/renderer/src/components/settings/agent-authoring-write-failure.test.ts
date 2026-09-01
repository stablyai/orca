import { describe, expect, it } from 'vitest'
import {
  agentAuthoringWriteFailureMessage,
  asAgentAuthoringWriteFailure
} from './agent-authoring-write-failure'

describe('asAgentAuthoringWriteFailure', () => {
  it('narrows a failed catalog write', () => {
    expect(asAgentAuthoringWriteFailure({ ok: false, code: 'agent_catalog_write_failed' })).toBe(
      'agent_catalog_write_failed'
    )
  })

  it('narrows a failed reference write', () => {
    expect(asAgentAuthoringWriteFailure({ ok: false, code: 'agent_reference_write_failed' })).toBe(
      'agent_reference_write_failed'
    )
  })

  it('ignores successes and other rejections', () => {
    expect(asAgentAuthoringWriteFailure({ ok: true })).toBeNull()
    expect(
      asAgentAuthoringWriteFailure({ ok: false, code: 'catalog_revision_conflict' })
    ).toBeNull()
    expect(asAgentAuthoringWriteFailure({ ok: false })).toBeNull()
  })
})

describe('agentAuthoringWriteFailureMessage', () => {
  it('states that nothing was saved and the user should retry', () => {
    const message = agentAuthoringWriteFailureMessage().toLowerCase()
    expect(message).toContain('nothing was changed')
    expect(message).toContain('try again')
  })
})
