import { describe, expect, it } from 'vitest'
import type { AgentSessionOwnerVerdict } from './agent-session-wire'
import { agentSessionOwnerVerdictAllowsFreshOperationId } from './agent-session-refusal-retry'
import { parseAgentSessionWriteFailure } from './agent-session-write-failure'
import {
  admitStructuredAgentSessionOutboxEntry,
  createStructuredAgentSessionOutboxEntry,
  requeueStructuredAgentSessionSendRefusal
} from './structured-agent-session-outbox'
import { disposeStructuredAgentSessionSendResult } from './structured-agent-session-send-disposition'

const entry = createStructuredAgentSessionOutboxEntry({
  clientMessageId: 'message-1',
  sessionId: 'session-1',
  text: 'hello',
  attachments: [],
  queuedAt: 1
})

/** A refused send as a reloaded entry holds it: through the saved shape and back. */
function storedOwnershipRefusal(ownerVerdict: AgentSessionOwnerVerdict | undefined) {
  const failure = parseAgentSessionWriteFailure(
    JSON.parse(
      JSON.stringify({
        kind: 'refused',
        code: 'agent_session_ownership_unknown',
        details: { reason: 'ownerUnproven', ...(ownerVerdict ? { ownerVerdict } : {}) }
      })
    )
  )
  if (failure?.kind !== 'refused') {
    throw new Error('the saved refusal did not read back')
  }
  return failure
}

function retried(ownerVerdict: AgentSessionOwnerVerdict | undefined) {
  return requeueStructuredAgentSessionSendRefusal(
    entry,
    storedOwnershipRefusal(ownerVerdict),
    () => 'message-2'
  )
}

describe("the owner's verdict decides a retry's operation id only as a floor", () => {
  it('lets a retry use a new id once the stored verdict proves nothing runs', () => {
    expect(agentSessionOwnerVerdictAllowsFreshOperationId('exited')).toBe(true)
    // A new id only: nothing recorded the message, so it stays queued at the head.
    expect(retried('exited')).toMatchObject({ clientMessageId: 'message-2', state: 'queued' })
  })

  it('keeps later sends behind the message after an exited refusal', () => {
    const later = createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'message-3',
      sessionId: 'session-1',
      text: 'after',
      attachments: [],
      queuedAt: 2
    })
    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [entry, later],
      entry,
      blockedClientMessageId: null,
      result: {
        ok: false,
        refusal: {
          code: 'agent_session_ownership_unknown',
          message: 'x',
          details: { reason: 'ownerUnproven', ownerVerdict: 'exited' }
        }
      },
      createOperationId: () => 'message-2'
    })
    expect(disposition.blockedClientMessageId).toBe('message-2')
    expect(
      admitStructuredAgentSessionOutboxEntry(
        disposition.entries,
        disposition.blockedClientMessageId
      )
    ).toMatchObject({ state: 'blocked', entry: { clientMessageId: 'message-2' } })
  })

  it.each<AgentSessionOwnerVerdict | undefined>(['unverifiable', 'live', undefined])(
    'keeps the id for a stored %s verdict, whose operation may still land',
    (stored) => {
      expect(agentSessionOwnerVerdictAllowsFreshOperationId(stored)).toBe(false)
      expect(retried(stored)).toMatchObject({ clientMessageId: 'message-1', state: 'queued' })
    }
  )

  it.each<AgentSessionOwnerVerdict | undefined>(['unverifiable', 'live', undefined])(
    'moves off a stored %s verdict only when the current lease proves the owner exited',
    (stored) => {
      expect(agentSessionOwnerVerdictAllowsFreshOperationId(stored, 'exited')).toBe(true)
      expect(agentSessionOwnerVerdictAllowsFreshOperationId(stored, 'unverifiable')).toBe(false)
      expect(agentSessionOwnerVerdictAllowsFreshOperationId(stored, 'live')).toBe(false)
    }
  )

  it('never lowers a stored exited', () => {
    expect(agentSessionOwnerVerdictAllowsFreshOperationId('exited', 'live')).toBe(true)
    expect(agentSessionOwnerVerdictAllowsFreshOperationId('exited', 'unverifiable')).toBe(true)
  })
})
