// What a rejection puts on the user's screen.
//
// The module is pure so this can be asserted directly instead of through the hook,
// which is the whole reason it was split out.

import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionMutationResult, AgentSessionSendResult } from './agent-session-wire'
import {
  dispatchWriteFailureReason,
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_QUEUE_FULL
} from './structured-agent-session-dispatch-rejection'
import { agentSessionWriteNoticeEnglish } from './agent-session-refusal-notice'
import {
  disposeStructuredAgentSessionSendFailure,
  disposeStructuredAgentSessionSendResult,
  structuredAgentSessionAttemptFailureParts
} from './structured-agent-session-send-disposition'
import {
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'

const entry: StructuredAgentSessionOutboxEntry = createStructuredAgentSessionOutboxEntry({
  clientMessageId: 'client-1',
  sessionId: 'session-1',
  text: 'hello',
  attachments: [],
  queuedAt: 1
})

function rejectedWith(reason: string | null): AgentSessionMutationResult<AgentSessionSendResult> {
  const submission: AgentJournalSubmission = {
    clientMessageId: 'client-1',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'rejected',
    providerItemId: null,
    reason,
    submittedAt: 10,
    resolvedAt: 10
  }
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 10 },
    value: { clientMessageId: 'client-1', submission }
  } as AgentSessionMutationResult<AgentSessionSendResult>
}

function notice(reason: string | null): string | undefined {
  const disposition = disposeStructuredAgentSessionSendResult({
    entries: [entry],
    entry,
    blockedClientMessageId: null,
    result: rejectedWith(reason),
    createOperationId: () => 'unused'
  })
  // The reason travels with the message it explains, never as a separate error.
  expect(disposition.error).toBeNull()
  const failure = disposition.entries[0]?.lastFailure
  return (
    failure && agentSessionWriteNoticeEnglish(structuredAgentSessionAttemptFailureParts(failure))
  )
}

describe('what a rejection shows the user', () => {
  it('removes a queued message the provider confirms Stop cancelled', () => {
    const result = rejectedWith(DISPATCH_REJECTED_CANCELLED)
    if (!result.ok) {
      throw new Error('expected rejected submission fixture')
    }

    expect(reconcileStructuredAgentSessionOutbox([entry], [result.value.submission])).toEqual([])
  })

  it('never puts the transport marker on screen', () => {
    const shown = notice(dispatchWriteFailureReason(new Error('broken pipe')))
    // `provider_write_failed: broken pipe` names nothing a person can act on.
    expect(shown).not.toContain('provider_write_failed')
    expect(shown).not.toContain('broken pipe')
    // And it says the message is safe to send again, which it is: the frame never left.
    expect(shown).toBe(
      "Couldn't reach the agent. Your message was not sent — Retry to send it again."
    )
  })

  it('shows a content rejection in the provider own words', () => {
    // The provider explaining itself IS the answer; a generic string throws it away.
    expect(notice('Claude messages support at most 20 images')).toBe(
      'Claude messages support at most 20 images'
    )
  })

  it('names the cause of a start that died before it could take the message', () => {
    // The host words this reason for the user: the child's own diagnostic, nothing internal.
    const reason =
      'The provider stopped before it finished starting: claude stream-json exited (code 1): claude: not signed in.'
    expect(notice(reason)).toBe(reason)
  })

  it('claims no cause when the rejection names none', () => {
    expect(notice(null)).toBe('Message was not sent.')
  })

  it('never puts a local-capacity marker on screen either', () => {
    // Neither the provider's words nor a transport failure: a refusal we minted
    // ourselves. It has no user-facing meaning, so it gets copy rather than the token.
    const shown = notice(DISPATCH_REJECTED_QUEUE_FULL)
    expect(shown).not.toContain('queue is full')
    expect(shown).toBe('Orca could not send your message — Retry to send it again.')
  })
})

describe('what a refusal shows the user', () => {
  it('keeps the refusal as a fact on the message, without the host diagnostic', () => {
    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [entry],
      entry,
      blockedClientMessageId: null,
      result: {
        ok: false,
        refusal: {
          code: 'agent_session_checkpoint_stale',
          message: 'Expected runtime fence 1; the session is at 3.'
        }
      },
      createOperationId: () => 'unused'
    })

    expect(disposition.error).toBeNull()
    expect(disposition.blockedClientMessageId).toBe(entry.clientMessageId)
    expect(disposition.entries).toMatchObject([
      {
        clientMessageId: entry.clientMessageId,
        state: 'queued',
        lastFailure: { kind: 'refused', code: 'agent_session_checkpoint_stale' }
      }
    ])
    expect(
      agentSessionWriteNoticeEnglish(
        structuredAgentSessionAttemptFailureParts(disposition.entries[0]!.lastFailure!)
      )
    ).toBe(
      "Orca couldn't confirm which agent process owns this chat. Your message was not sent. Retry to send it again."
    )
  })

  it('keeps an unreachable host as a fact, not a transport error string', () => {
    const disposition = disposeStructuredAgentSessionSendFailure({
      entries: [entry],
      entry,
      blockedClientMessageId: null,
      cause: new Error('socket hang up: ECONNRESET 10.0.0.2:443'),
      isDeliveryUnknown: () => false
    })

    expect(disposition.error).toBeNull()
    expect(disposition.entries[0]?.lastFailure).toEqual({ kind: 'unreachable' })
  })

  it('drops the reason once the same message is accepted', () => {
    const refused: StructuredAgentSessionOutboxEntry = {
      ...entry,
      lastFailure: { kind: 'refused', code: 'agent_session_checkpoint_stale' }
    }
    const result = rejectedWith(null)
    if (!result.ok) {
      throw new Error('expected a send result')
    }
    result.value.submission = { ...result.value.submission, dispatchState: 'accepted' }
    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [refused],
      entry: refused,
      blockedClientMessageId: null,
      result,
      createOperationId: () => 'unused'
    })

    expect(disposition.entries).toEqual([])
    expect(disposition.error).toBeNull()
  })
})

describe('ambiguous operation refusals', () => {
  it.each([
    { ...entry, state: 'unconfirmed' as const, lastAttemptAt: 10 },
    { ...entry, state: 'queued' as const, lastAttemptAt: 10, retryAfterUnknownSubmittedAt: 10 }
  ])('never rotates $state operation after its host tombstone expires', (ambiguous) => {
    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [ambiguous],
      entry: ambiguous,
      blockedClientMessageId: null,
      result: {
        ok: false,
        refusal: {
          code: 'agent_session_operation_expired',
          message: 'Operation expired.'
        }
      },
      createOperationId: () => 'fresh-id'
    })

    expect(disposition.entries).toMatchObject([
      { clientMessageId: entry.clientMessageId, state: 'queued' }
    ])
    expect(disposition.blockedClientMessageId).toBe(entry.clientMessageId)
  })

  it('parks a recovered missing submission without polling forever', () => {
    const result = rejectedWith(null)
    if (!result.ok) {
      throw new Error('expected a send result')
    }
    result.value.submission = {
      ...result.value.submission,
      dispatchState: 'unknown',
      reason: 'durable_send_submission_missing',
      recovered: true
    }

    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [entry],
      entry,
      blockedClientMessageId: null,
      result,
      createOperationId: () => 'unused'
    })

    expect(disposition.entries).toMatchObject([
      {
        clientMessageId: entry.clientMessageId,
        state: 'unconfirmed',
        retryAfterUnknownSubmittedAt: -1
      }
    ])
  })
})
