// The link from a submission to the queued draft it hands off (`queuedMessageId`) decides every
// question about who owns a queued send; a draft id is never compared with a submission id.

import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import { reconcileStructuredAgentSessionOutboxWithQueue } from './structured-agent-session-draft-hand-off'
import {
  disposeStructuredAgentSessionSendResult,
  journalAnswersInFlightSend
} from './structured-agent-session-send-disposition'
import { hasUnsentStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-stop-withdrawal'

const entry: StructuredAgentSessionOutboxEntry = {
  ...createStructuredAgentSessionOutboxEntry({
    clientMessageId: 'draft',
    sessionId: 'session-1',
    text: 'hello',
    attachments: [],
    queuedAt: 1
  }),
  sentDelivery: 'queue-if-active',
  state: 'unconfirmed',
  lastAttemptAt: 5
}

function handOff(dispatchState: AgentJournalSubmission['dispatchState']): AgentJournalSubmission {
  return {
    clientMessageId: 'hand-off',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState,
    providerItemId: null,
    reason: dispatchState === 'rejected' ? 'refused' : null,
    submittedAt: 10,
    resolvedAt: null,
    queuedMessageId: 'draft'
  }
}

describe('a queued draft handed off under a fresh submission id', () => {
  it('takes the outbox entry off the client, in every dispatch state', () => {
    for (const state of ['pending', 'accepted', 'rejected', 'unknown'] as const) {
      expect(reconcileStructuredAgentSessionOutboxWithQueue([entry], [handOff(state)])).toEqual([])
    }
  })

  it('answers the send in flight and leaves nothing a Stop would withdraw', () => {
    expect(journalAnswersInFlightSend([handOff('pending')], 'draft')).toBe(true)
    expect(journalAnswersInFlightSend([handOff('pending')], null)).toBe(false)
    expect(hasUnsentStructuredAgentSessionOutboxEntry([entry], [handOff('pending')], null)).toBe(
      false
    )
  })

  it('settles a replayed send answered with the hand-off, with no notice', () => {
    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [entry],
      entry,
      blockedClientMessageId: null,
      createOperationId: () => 'rotated',
      result: {
        ok: true,
        replayed: true,
        fence: 1,
        cursor: { epoch: 'epoch-1', sequence: 10 },
        value: { clientMessageId: 'hand-off', submission: handOff('rejected') }
      }
    })
    expect(disposition).toEqual({ entries: [], error: null, blockedClientMessageId: null })
  })
})
