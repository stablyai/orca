import { describe, expect, it } from 'vitest'
import {
  agentSessionRefusalFailure,
  agentSessionThrownFailure
} from './agent-session-write-failure'

describe('agentSessionRefusalFailure', () => {
  // What moves with the owner, the question's answer and the host's words are never kept.
  it('keeps only the facts that stay true after a reload', () => {
    expect(
      agentSessionRefusalFailure({
        code: 'agent_session_checkpoint_stale',
        details: { reason: 'fenceStale', currentFence: 3, ownerVerdict: 'exited' }
      })
    ).toEqual({
      kind: 'refused',
      code: 'agent_session_checkpoint_stale',
      details: { reason: 'fenceStale' }
    })
    // A prompt's revision and winning answer, and a provider's diagnostic, as a host may send them.
    const answered = JSON.parse(
      JSON.stringify({
        code: 'agent_session_already_resolved',
        details: {
          reason: 'promptAlreadyResolved',
          currentRevision: 2,
          resolution: { state: 'answered', selectedOptionId: 'yes', resolvedBy: 'phone' },
          detail: { text: 'stderr', audience: 'log' }
        }
      })
    )
    expect(agentSessionRefusalFailure(answered)).toEqual({
      kind: 'refused',
      code: 'agent_session_already_resolved',
      details: { reason: 'promptAlreadyResolved' }
    })
  })
})

describe('a refusal a failed request carried in its error', () => {
  const refusal = {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalCorrupt', stray: 'dropped' }
  }
  const payload = { code: 'runtime_error', message: 'agent_session_journal_unreadable' }

  it("words the refusal when there is one, else what the request's error code proves", () => {
    expect(agentSessionThrownFailure({ ...payload, data: { refusal } }, 'runtime_error')).toEqual({
      kind: 'refused',
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalCorrupt' }
    })
    expect(agentSessionThrownFailure(payload, 'runtime_error')).toEqual({ kind: 'unconfirmed' })
    expect(agentSessionThrownFailure(payload, 'method_not_found')).toEqual({
      kind: 'refused',
      code: 'structured_agent_session_unsupported'
    })
  })
})
