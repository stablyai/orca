// A message whose delivery is in doubt holds the queue only while the host may never have received
// it. Once the host records it in doubt, its place is fixed and the host never sends it again, so
// its entry leaves the outbox and what follows it goes out.

import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import { admitStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-admission'
import { disposeStructuredAgentSessionSendResult } from './structured-agent-session-send-disposition'

function entry(
  clientMessageId: string,
  patch: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId,
      sessionId: 'session-1',
      text: clientMessageId,
      attachments: [],
      queuedAt: 1
    }),
    ...patch
  }
}

function unknown(
  clientMessageId: string,
  patch: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'unknown',
    providerItemId: null,
    reason: 'provider_closed_before_acknowledgement',
    submittedAt: 5,
    resolvedAt: 6,
    recovered: true,
    ...patch
  }
}

function answered(
  submission: AgentJournalSubmission,
  entries: StructuredAgentSessionOutboxEntry[]
) {
  return disposeStructuredAgentSessionSendResult({
    entries,
    entry: entries[0]!,
    result: {
      ok: true,
      replayed: true,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 7 },
      value: { clientMessageId: submission.clientMessageId, submission }
    },
    createOperationId: () => 'unused'
  })
}

describe('a message the host records in doubt', () => {
  it.each<[string, Partial<StructuredAgentSessionOutboxEntry>, Partial<AgentJournalSubmission>]>([
    ['on its way, the doubt outliving its writer', { state: 'dispatching' }, {}],
    [
      'already unconfirmed, the doubt still outstanding',
      { state: 'unconfirmed' },
      { recovered: undefined }
    ],
    [
      'retried before the record was seen',
      { state: 'unconfirmed', retryAfterUnknownSubmittedAt: -1 },
      {}
    ]
  ])('leaves the outbox when the journal records it, %s', (_case, entryPatch, recorded) => {
    const outbox = reconcileStructuredAgentSessionOutbox(
      [entry('doubt', { lastAttemptAt: 2, ...entryPatch }), entry('next')],
      [unknown('doubt', recorded)]
    )
    expect(outbox.map((candidate) => candidate.clientMessageId)).toEqual(['next'])
    expect(admitStructuredAgentSessionOutboxEntry(outbox)).toEqual({
      state: 'dispatch',
      entry: outbox[0]
    })
  })

  it('leaves the outbox when the host answers a send or its replay in doubt', () => {
    for (const recovered of [true, undefined] as const) {
      const { entries, error } = answered(unknown('doubt', { recovered }), [
        entry('doubt', { state: 'dispatching', lastAttemptAt: 2 }),
        entry('next')
      ])
      expect(entries.map((candidate) => candidate.clientMessageId)).toEqual(['next'])
      expect(error).toBeNull()
    }
  })

  // Only this entry shows a message whose row the host lost, so it stays, as before.
  it('stays when the host lost its row', () => {
    const { entries } = answered(unknown('doubt', { reason: 'durable_send_submission_missing' }), [
      entry('doubt', { state: 'dispatching', lastAttemptAt: 2 })
    ])
    expect(entries).toMatchObject([{ state: 'unconfirmed', retryAfterUnknownSubmittedAt: -1 }])
  })

  // A Retry asked of this very submission waits for the host's answer to it.
  it('stays while the user retries that same submission', () => {
    const retried = entry('doubt', { lastAttemptAt: 2, retryAfterUnknownSubmittedAt: 5 })
    expect(reconcileStructuredAgentSessionOutbox([retried], [unknown('doubt')])).toEqual([retried])
  })
})

describe('a message the host may never have received', () => {
  it('holds what follows it until the host answers it', () => {
    const outbox = reconcileStructuredAgentSessionOutbox(
      [entry('doubt', { state: 'unconfirmed', lastAttemptAt: 2 }), entry('next')],
      // Another message's row, or the window of rows loaded after this one's aged out.
      [unknown('other')]
    )
    expect(admitStructuredAgentSessionOutboxEntry(outbox)).toEqual({
      state: 'blocked',
      entry: outbox[0]
    })
    // The probe's replay of it is the host's answer: it recorded it, and what follows goes.
    const { entries } = answered(unknown('doubt'), outbox)
    expect(admitStructuredAgentSessionOutboxEntry(entries)).toEqual({
      state: 'dispatch',
      entry: entries[0]
    })
    expect(entries.map((candidate) => candidate.clientMessageId)).toEqual(['next'])
  })
})
