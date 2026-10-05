// What a rejection puts on the user's screen.
//
// The module is pure so this can be asserted directly instead of through the hook,
// which is the whole reason it was split out.

import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionMutationResult, AgentSessionSendResult } from './agent-session-wire'
import {
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
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import { reconcileStructuredAgentSessionOutbox } from './structured-agent-session-outbox-reconcile'
import { structuredAgentSessionEntryHeldForRetry } from './structured-agent-session-outbox-admission'

const entry: StructuredAgentSessionOutboxEntry = createStructuredAgentSessionOutboxEntry({
  clientMessageId: 'client-1',
  sessionId: 'session-1',
  text: 'hello',
  attachments: [],
  queuedAt: 1
})

function rejectedWith(
  reason: string | null,
  extra: { rejection?: AgentSessionFailureFact; replayed?: boolean } = {}
): AgentSessionMutationResult<AgentSessionSendResult> {
  const submission: AgentJournalSubmission = {
    clientMessageId: 'client-1',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'rejected',
    providerItemId: null,
    reason,
    submittedAt: 10,
    resolvedAt: 10,
    ...(extra.rejection ? { rejection: extra.rejection } : {})
  }
  return {
    ok: true,
    replayed: extra.replayed ?? false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 10 },
    value: { clientMessageId: 'client-1', submission }
  }
}

function notice(reason: string | null, rejection?: AgentSessionFailureFact): string | undefined {
  const disposition = disposeStructuredAgentSessionSendResult({
    entries: [entry],
    entry,
    result: rejectedWith(reason, rejection ? { rejection } : {}),
    createOperationId: () => 'unused'
  })
  // The reason travels with the message it explains, never as a separate error.
  expect(disposition.error).toBeNull()
  const failure = disposition.entries[0]?.lastFailure
  return (
    failure && agentSessionWriteNoticeEnglish(structuredAgentSessionAttemptFailureParts(failure))
  )
}

describe('a queued draft answer', () => {
  it('retires the outbox entry: the host-held draft carries any later refusal', () => {
    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [entry],
      entry,
      result: {
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'epoch-1', sequence: 10 },
        value: {
          clientMessageId: 'client-1',
          queued: { messageId: 'client-1', position: 1, state: 'waiting' }
        }
      },
      createOperationId: () => 'unused'
    })
    expect(disposition.entries).toEqual([])
    expect(disposition.error).toBeNull()
  })

  it('a withdrawn replay is spent, not unknown', () => {
    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [entry],
      entry,
      result: {
        ok: true,
        replayed: true,
        fence: 1,
        cursor: { epoch: 'epoch-1', sequence: 10 },
        value: {
          clientMessageId: 'client-1',
          queued: { messageId: 'client-1', position: 1, state: 'withdrawn' }
        }
      },
      createOperationId: () => 'unused'
    })
    expect(disposition.entries).toEqual([])
    expect(disposition.error).toBeNull()
  })
})

describe('what a rejection shows the user', () => {
  it('removes a queued message the provider confirms Stop cancelled', () => {
    const result = rejectedWith(DISPATCH_REJECTED_CANCELLED)
    if (!result.ok || !('submission' in result.value)) {
      throw new Error('expected rejected submission fixture')
    }

    expect(reconcileStructuredAgentSessionOutbox([entry], [result.value.submission], [])).toEqual(
      []
    )
  })

  it('never puts the transport marker on screen', () => {
    const shown = notice('provider_write_failed: broken pipe')
    // `provider_write_failed: broken pipe` names nothing a person can act on.
    expect(shown).not.toContain('provider_write_failed')
    expect(shown).not.toContain('broken pipe')
    expect(shown).toBe("Orca couldn't reach the agent. Your message was not sent.")
  })

  it('shows a content rejection in the provider own words', () => {
    // The provider explaining itself IS the answer; a generic string throws it away.
    expect(notice('Claude messages support at most 20 images')).toBe(
      'Claude messages support at most 20 images'
    )
  })

  it('shows the sentence a host wrote for the person reading it', () => {
    const reason = 'The provider stopped before it finished starting.'
    expect(notice(reason)).toBe(reason)
  })

  it('never puts the legacy not_delivered marker on screen', () => {
    // Released clients printed it as it was; it is a marker, not a sentence.
    expect(notice('not_delivered')).toBe('Your message was not sent.')
  })

  it.each([
    ['the legacy marker alone', undefined],
    ['the marker and its typed fact', { kind: 'cancelled' as const }]
  ])('fails nothing for a Stop-withdrawn send, first reply or replay: %s', (_label, rejection) => {
    for (const replayed of [false, true]) {
      const disposition = disposeStructuredAgentSessionSendResult({
        entries: [entry],
        entry,
        result: rejectedWith(DISPATCH_REJECTED_CANCELLED, { rejection, replayed }),
        createOperationId: () => 'unused'
      })
      expect(disposition).toEqual({ entries: [], error: null })
    }
  })

  it('reads a withdrawal off the typed fact whatever the reason says', () => {
    const result = rejectedWith('Withdrawn.', { rejection: { kind: 'cancelled' } })
    if (!result.ok || !('submission' in result.value)) {
      throw new Error('expected rejected submission fixture')
    }
    expect(reconcileStructuredAgentSessionOutbox([entry], [result.value.submission], [])).toEqual(
      []
    )
    expect(
      disposeStructuredAgentSessionSendResult({
        entries: [entry],
        entry,
        result,
        createOperationId: () => 'unused'
      }).error
    ).toBeNull()
  })

  it('claims no cause when the rejection names none', () => {
    expect(notice(null)).toBe('Your message was not sent.')
  })

  it('never puts a local-capacity marker on screen either', () => {
    // Neither the provider's words nor a transport failure: a refusal we minted
    // ourselves. It has no user-facing meaning, so it gets copy rather than the token.
    const shown = notice(DISPATCH_REJECTED_QUEUE_FULL)
    expect(shown).not.toContain('queue is full')
    expect(shown).toBe('Your message was not sent.')
  })
})

// A row that carries the host's fact is worded from it; the reason is not read.
describe('what a rejection with a typed fact shows the user', () => {
  it('says Orca could not hand the message over, whatever the reason holds', () => {
    expect(notice('provider_write_failed', { kind: 'writeFailed' })).toBe(
      "Orca couldn't reach the agent. Your message was not sent."
    )
    expect(notice('Something unrelated.', { kind: 'writeFailed' })).toBe(
      "Orca couldn't reach the agent. Your message was not sent."
    )
  })

  it("rebuilds the fact's sentence where a marker stands in for it", () => {
    expect(notice(DISPATCH_REJECTED_QUEUE_FULL, { kind: 'queueFull' })).toBe(
      'Too many messages were waiting for the agent, so this one was not sent.'
    )
  })

  // The surface names the agent; the host's own sentence is never compared or shown.
  it('words the fact itself, never the sentence the host wrote beside it', () => {
    expect(
      notice('Claude never finished starting, so Orca stopped it.', { kind: 'hostStopped' })
    ).toBe('The agent never finished starting, so Orca stopped it.')
  })

  // The message keeps no fact it cannot place, so the host's sentence stands, as on an older host.
  it("shows a newer host's sentence when its fact cannot be placed", () => {
    expect(notice('A sentence a newer host wrote.', JSON.parse('{"kind":"fromTheFuture"}'))).toBe(
      'A sentence a newer host wrote.'
    )
  })

  // The message's copy drops the detail and the refusal these kinds are worded from, so the
  // sentence the host wrote for the person stands in for them; with none, the table's words.
  it("shows the host's sentence for a kind whose words its copy cannot rebuild", () => {
    expect(
      notice('The provider did not accept this message: Image type .bmp.', {
        kind: 'providerRejected',
        detail: { text: 'Image type .bmp', audience: 'person' }
      })
    ).toBe('The provider did not accept this message: Image type .bmp.')
    expect(
      notice("Claude couldn't start. Start a new chat to continue.", {
        kind: 'startFailed',
        refusal: { code: 'agent_session_identity_required' }
      })
    ).toBe("Claude couldn't start. Start a new chat to continue.")
    expect(notice(null, { kind: 'providerRejected' })).toBe(
      'The provider did not accept this message.'
    )
  })

  it('says only that the message was not sent for a fact no message can carry', () => {
    expect(notice('Compaction failed.', { kind: 'compactionFailed' })).toBe(
      'Your message was not sent.'
    )
  })
})

describe('what a refusal shows the user', () => {
  it('keeps the refusal as a fact on the message, without the host diagnostic', () => {
    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [entry],
      entry,
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
    expect(structuredAgentSessionEntryHeldForRetry(disposition.entries[0]!)).toBe(true)
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
    ).toBe('Your message was not sent.')
  })

  it("keeps the reason the host named, and says it on the message's Retry row", () => {
    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [entry],
      entry,
      result: {
        ok: false,
        refusal: {
          code: 'agent_session_conflict',
          message: 'The chat is still starting.',
          details: { reason: 'chatStarting' }
        }
      },
      createOperationId: () => 'unused'
    })

    const lastFailure = disposition.entries[0]?.lastFailure
    expect(lastFailure).toEqual({
      kind: 'refused',
      code: 'agent_session_conflict',
      details: { reason: 'chatStarting' }
    })
    expect(
      agentSessionWriteNoticeEnglish(structuredAgentSessionAttemptFailureParts(lastFailure!))
    ).toBe(
      'The agent is still starting. Your message was not sent. Wait for the agent to finish starting.'
    )
  })

  it("keeps a rejected message's typed fact without the provider's detail", () => {
    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [entry],
      entry,
      result: rejectedWith('An image on this message is empty, so the message was not sent.', {
        rejection: {
          kind: 'attachmentInvalid',
          attachment: { reason: 'empty' },
          detail: { text: 'image block 2: zero bytes', audience: 'log' }
        }
      }),
      createOperationId: () => 'unused'
    })

    expect(disposition.entries[0]?.lastFailure).toEqual({
      kind: 'rejected',
      reason: 'An image on this message is empty, so the message was not sent.',
      rejection: { kind: 'attachmentInvalid', attachment: { reason: 'empty' } }
    })
  })

  it('keeps a failed request as a fact, not a transport error string', () => {
    const disposition = disposeStructuredAgentSessionSendFailure({
      entries: [entry],
      entry,
      cause: new Error('socket hang up: ECONNRESET 10.0.0.2:443'),
      isDeliveryUnknown: () => false
    })

    expect(disposition.error).toBeNull()
    expect(disposition.entries[0]?.lastFailure).toEqual({ kind: 'failed' })
  })

  it('drops the reason once the same message is accepted', () => {
    const refused: StructuredAgentSessionOutboxEntry = {
      ...entry,
      lastFailure: { kind: 'refused', code: 'agent_session_checkpoint_stale' }
    }
    const result = rejectedWith(null)
    if (!result.ok || !('submission' in result.value)) {
      throw new Error('expected a send result')
    }
    result.value.submission = { ...result.value.submission, dispatchState: 'accepted' }
    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [refused],
      entry: refused,
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
  ])(
    'never rotates $state operation after its host tombstone expires; holds it for its Retry',
    (ambiguous) => {
      const disposition = disposeStructuredAgentSessionSendResult({
        entries: [ambiguous],
        entry: ambiguous,
        result: {
          ok: false,
          refusal: {
            code: 'agent_session_operation_expired',
            message: 'Operation expired.'
          }
        },
        createOperationId: () => 'fresh-id'
      })

      // An earlier attempt under the kept id may have landed, so no new id goes out on its own.
      expect(disposition.entries).toMatchObject([
        {
          clientMessageId: entry.clientMessageId,
          state: 'queued',
          lastFailure: { kind: 'refused', code: 'agent_session_operation_expired' }
        }
      ])
      expect(structuredAgentSessionEntryHeldForRetry(disposition.entries[0]!)).toBe(true)
      expect(disposition.error).toBeNull()
    }
  )

  it('rotates a first attempt the host calls expired, which nothing can have delivered', () => {
    const disposition = disposeStructuredAgentSessionSendResult({
      entries: [entry],
      entry,
      result: {
        ok: false,
        refusal: { code: 'agent_session_operation_expired', message: 'Operation expired.' }
      },
      createOperationId: () => 'fresh-id'
    })

    expect(disposition.entries).toMatchObject([{ clientMessageId: 'fresh-id', state: 'rejected' }])
  })

  it('parks a recovered missing submission without polling forever', () => {
    const result = rejectedWith(null)
    if (!result.ok || !('submission' in result.value)) {
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
