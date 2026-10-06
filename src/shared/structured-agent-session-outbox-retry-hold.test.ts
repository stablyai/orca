import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import { reconcileStructuredAgentSessionOutbox } from './structured-agent-session-outbox-reconcile'
import {
  admitStructuredAgentSessionOutboxEntry,
  structuredAgentSessionEntryHeldForRetry
} from './structured-agent-session-outbox-admission'

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

const REFUSED = { kind: 'refused', code: 'agent_session_journal_unreadable' } as const

describe('a message held for its Retry', () => {
  it('is one the user was told did not go through, and still queued', () => {
    expect(structuredAgentSessionEntryHeldForRetry(entry('a', { lastFailure: REFUSED }))).toBe(true)
    expect(
      structuredAgentSessionEntryHeldForRetry(entry('a', { lastFailure: { kind: 'failed' } }))
    ).toBe(true)
    expect(structuredAgentSessionEntryHeldForRetry(entry('a'))).toBe(false)
    expect(
      structuredAgentSessionEntryHeldForRetry(
        entry('a', { state: 'rejected', lastFailure: { kind: 'rejected', reason: null } })
      )
    ).toBe(false)
  })

  it('is passed over by the drain, which still stops on a message in doubt', () => {
    const held = entry('held', { lastFailure: REFUSED })
    expect(admitStructuredAgentSessionOutboxEntry([held])).toEqual({ state: 'idle', entry: null })
    expect(admitStructuredAgentSessionOutboxEntry([held, entry('next')])).toMatchObject({
      state: 'dispatch',
      entry: { clientMessageId: 'next' }
    })
    expect(
      admitStructuredAgentSessionOutboxEntry([
        held,
        entry('doubt', { state: 'unconfirmed' }),
        entry('next')
      ])
    ).toMatchObject({ state: 'blocked', entry: { clientMessageId: 'doubt' } })
  })

  it('is released once the host shows it has the message after all', () => {
    const submission: AgentJournalSubmission = {
      clientMessageId: 'held',
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState: 'pending',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null
    }
    const [landed] = reconcileStructuredAgentSessionOutbox(
      [entry('held', { lastFailure: REFUSED })],
      [submission],
      []
    )
    expect(landed?.state).toBe('dispatching')
    expect(landed?.lastFailure).toBeUndefined()
  })

  // Any fresh word on where a message stands supersedes an earlier attempt's failure.
  it('is in doubt, and holds the queue, once the host says it cannot tell whether it landed', () => {
    const submission: AgentJournalSubmission = {
      clientMessageId: 'held',
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState: 'unknown',
      providerItemId: null,
      reason: null,
      submittedAt: 5,
      resolvedAt: null
    }
    const reconciled = reconcileStructuredAgentSessionOutbox(
      [entry('held', { lastAttemptAt: 2, lastFailure: REFUSED }), entry('next')],
      [submission],
      []
    )
    expect(reconciled[0]).toMatchObject({ state: 'unconfirmed' })
    expect(reconciled[0]?.lastFailure).toBeUndefined()
    expect(admitStructuredAgentSessionOutboxEntry(reconciled)).toMatchObject({
      state: 'blocked',
      entry: { clientMessageId: 'held' }
    })
  })
})
