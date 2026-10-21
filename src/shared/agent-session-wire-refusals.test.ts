import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_REFUSAL_REASONS,
  readAgentSessionRefusalDetails
} from './agent-session-refusal-details'
import {
  AGENT_SESSION_WIRE_REFUSAL_CODES,
  agentSessionRefusalError,
  agentSessionRefusalReference,
  readAgentSessionRefusalReference,
  refuse,
  refuseUnclassified,
  withAgentSessionRefusalFacts,
  type AgentSessionWireRefusal
} from './agent-session-wire-refusals'
import type { AgentJournalResolution } from './agent-session-journal-types'

const RESOLUTION: AgentJournalResolution = {
  state: 'resolved',
  selectedOptionId: 'allow',
  resolvedBy: 'phone-1',
  resolvedAt: 1_789_000_000_000
}

/** The refusal with its new field removed: exactly what a released client reads. */
function asReleasedClientSeesIt(refusal: AgentSessionWireRefusal): unknown {
  const { details: _details, ...rest } = JSON.parse(JSON.stringify(refusal))
  return rest
}

describe('a refusal names only a reason its code lists', () => {
  it('rejects a reason another code lists, at compile time', () => {
    // @ts-expect-error `promptGone` is an operation_invalid reason, not a conflict one.
    refuse('agent_session_conflict', { reason: 'promptGone' }, 'm')
    // @ts-expect-error the thrown form is held to the same list.
    agentSessionRefusalError('agent_session_identity_required', { reason: 'claimConflicted' })
    // @ts-expect-error a fact another code carries is not this code's.
    refuse('agent_session_conflict', { reason: 'ownerAlive', currentFence: 3 }, 'm')
    // @ts-expect-error the unclassified path cannot carry a reason.
    refuseUnclassified('agent_session_conflict', 'm', { reason: 'claimConflicted' })
    expect(refuse('agent_session_conflict', { reason: 'ownerAlive' }, 'm').details).toEqual({
      reason: 'ownerAlive'
    })
  })

  it('has no catch-all reason under any code', () => {
    for (const code of AGENT_SESSION_WIRE_REFUSAL_CODES) {
      for (const reason of AGENT_SESSION_REFUSAL_REASONS[code]) {
        expect([code, reason]).not.toEqual([code, expect.stringMatching(/^(other|unknown)$/i)])
        expect(reason).not.toMatch(/fault|generic|misc/i)
      }
    }
  })
})

describe('the loose fields released clients read', () => {
  it('are copied from details by refuse, one field at a time', () => {
    expect(
      refuse('agent_session_checkpoint_stale', { reason: 'fenceStale', currentFence: 4 }, 'm')
    ).toMatchObject({ currentFence: 4 })
    expect(
      refuse(
        'agent_session_item_revision_stale',
        { reason: 'promptMoved', currentRevision: 2, resolution: RESOLUTION },
        'm'
      )
    ).toMatchObject({ currentRevision: 2, resolution: RESOLUTION })
    expect(
      refuse(
        'agent_session_operation_invalid',
        { reason: 'rewindRefused', rewindReason: 'busy' },
        'm'
      )
    ).toMatchObject({ rewindReason: 'busy' })
    expect(
      refuse(
        'agent_session_ownership_unknown',
        { reason: 'ownerUnproven', ownerVerdict: 'exited' },
        'm'
      )
    ).toMatchObject({ ownerVerdict: 'exited' })
    expect(
      refuseUnclassified('agent_session_checkpoint_stale', 'm', { currentFence: 9 })
    ).toMatchObject({ currentFence: 9, details: { currentFence: 9 } })
  })

  it('gain a verdict learned after the refusal, in details and at the top level', () => {
    const stamped = withAgentSessionRefusalFacts(
      refuse('agent_session_operation_invalid', { reason: 'providerStartFailed' }, 'm'),
      { ownerVerdict: 'exited' }
    )
    expect(stamped).toEqual({
      code: 'agent_session_operation_invalid',
      message: 'm',
      details: { reason: 'providerStartFailed', ownerVerdict: 'exited' },
      ownerVerdict: 'exited'
    })
    // A refusal an older row replayed, with no reason, still reaches released clients with it.
    expect(
      withAgentSessionRefusalFacts(refuseUnclassified('agent_session_conflict', 'm'), {
        ownerVerdict: 'unverifiable'
      })
    ).toEqual({
      code: 'agent_session_conflict',
      message: 'm',
      details: { ownerVerdict: 'unverifiable' },
      ownerVerdict: 'unverifiable'
    })
  })

  // Each expected value is the literal the host built for the same situation before details.
  it.each([
    [
      'a moved prompt',
      refuse(
        'agent_session_item_revision_stale',
        { reason: 'promptMoved', currentRevision: 2, resolution: RESOLUTION },
        'Item i has moved on.'
      ),
      {
        code: 'agent_session_item_revision_stale',
        message: 'Item i has moved on.',
        currentRevision: 2,
        resolution: RESOLUTION
      }
    ],
    [
      'a resolved prompt',
      refuse(
        'agent_session_already_resolved',
        { reason: 'promptAlreadyResolved', currentRevision: 2, resolution: RESOLUTION },
        'Item i was already resolved.'
      ),
      {
        code: 'agent_session_already_resolved',
        message: 'Item i was already resolved.',
        currentRevision: 2,
        resolution: RESOLUTION
      }
    ],
    [
      'a stale fence',
      refuse('agent_session_checkpoint_stale', { reason: 'fenceStale', currentFence: 4 }, 'm'),
      { code: 'agent_session_checkpoint_stale', message: 'm', currentFence: 4 }
    ],
    [
      'a refused rewind',
      refuse(
        'agent_session_operation_invalid',
        { reason: 'rewindRefused', rewindReason: 'busy' },
        'agent_session_rewind:busy'
      ),
      {
        code: 'agent_session_operation_invalid',
        message: 'agent_session_rewind:busy',
        rewindReason: 'busy'
      }
    ],
    [
      'a failed create',
      withAgentSessionRefusalFacts(
        refuse('agent_session_operation_invalid', { reason: 'providerStartFailed' }, 'exited 1'),
        { ownerVerdict: 'exited' }
      ),
      { code: 'agent_session_operation_invalid', message: 'exited 1', ownerVerdict: 'exited' }
    ],
    [
      'a refusal with no facts',
      refuse('agent_session_conflict', { reason: 'claimConflicted' }, 'm'),
      { code: 'agent_session_conflict', message: 'm' }
    ]
  ] as const)('read by a released client exactly as before for %s', (_label, refusal, before) => {
    expect(asReleasedClientSeesIt(refusal)).toEqual(before)
  })
})

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

  it('round-trips through its reference, and reads an older shape as naming nothing', () => {
    const refusal = refuse(
      'agent_session_ownership_unknown',
      { reason: 'noLiveOwner', ownerVerdict: 'live' },
      'm'
    )
    const reference = agentSessionRefusalReference(refusal)
    expect(reference).toEqual({
      code: 'agent_session_ownership_unknown',
      details: { reason: 'noLiveOwner', ownerVerdict: 'live' }
    })
    expect(readAgentSessionRefusalReference(JSON.parse(JSON.stringify(reference)))).toEqual(
      reference
    )
    expect(
      readAgentSessionRefusalReference({ code: 'agent_session_conflict', cause: 'claimConflicted' })
    ).toEqual({ code: 'agent_session_conflict' })
    expect(readAgentSessionRefusalReference({ code: 'agent_session_future' })).toBeUndefined()
  })
})
