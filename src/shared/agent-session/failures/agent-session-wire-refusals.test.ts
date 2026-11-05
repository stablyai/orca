import { describe, expect, it } from 'vitest'
import { readAgentSessionRefusalDetails } from './agent-session-refusal-details'
import './agent-session-wire-refusals'

describe('a stored refusal read back', () => {
  it('keeps what the code lists and drops the rest', () => {
    expect(
      readAgentSessionRefusalDetails('agent_session_checkpoint_stale', {
        reason: 'fenceStale',
        currentFence: 3,
        currentRevision: 8,
        cause: 'fenceStale'
      })
    ).toEqual({ reason: 'fenceStale', currentFence: 3 })
    // A reason a newer host added reads as none, but the facts beside it still count.
    expect(
      readAgentSessionRefusalDetails('agent_session_checkpoint_stale', {
        reason: 'futureReason',
        currentFence: 3
      })
    ).toEqual({ currentFence: 3 })
    expect(readAgentSessionRefusalDetails('agent_session_conflict', { reason: 'x' })).toBe(
      undefined
    )
  })
})
