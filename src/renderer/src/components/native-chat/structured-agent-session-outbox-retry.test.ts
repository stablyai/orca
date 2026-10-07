// @vitest-environment happy-dom

// A send made while a Stop was ending a turn waits behind that turn. Retrying it later is a new
// send: it must not wait behind some later, unrelated turn a Stop is ending.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { DISPATCH_REJECTED_WRITE_FAILED } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { retryStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-retry'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'

const SESSION = 'session-1'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

function sentWhileStopping(state: 'unconfirmed' | 'rejected') {
  writeOutbox(SESSION, [
    {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: 'held',
        sessionId: SESSION,
        text: 'follow-up',
        attachments: [],
        queuedAt: 1
      }),
      lastAttemptAt: 5,
      outlivedStop: true,
      sentWhileStopping: true,
      state
    }
  ])
}

function retry(submissions: AgentJournalSubmission[] = []): void {
  retryStructuredAgentSessionOutboxEntry({
    clientMessageId: 'held',
    sessionId: SESSION,
    submissions,
    setError: vi.fn(),
    createOperationId: () => 'retried'
  })
}

describe('Retry on a send made while a Stop was ending a turn', () => {
  it('sends it as a new send, no longer waiting behind a Stop', () => {
    sentWhileStopping('unconfirmed')

    retry()

    expect(readOutbox(SESSION)).toEqual([
      expect.objectContaining({ clientMessageId: 'held', state: 'queued' })
    ])
    expect(readOutbox(SESSION)[0]).not.toHaveProperty('sentWhileStopping')
    expect(readOutbox(SESSION)[0]).not.toHaveProperty('outlivedStop')
  })

  it('does the same when the Retry rotates the id of a send the host refused', () => {
    sentWhileStopping('rejected')

    retry([
      {
        clientMessageId: 'held',
        fence: 1,
        payloadFingerprint: 'held',
        dispatchState: 'rejected',
        providerItemId: null,
        reason: DISPATCH_REJECTED_WRITE_FAILED,
        submittedAt: 1,
        resolvedAt: 2
      }
    ])

    expect(readOutbox(SESSION)).toEqual([
      expect.objectContaining({ clientMessageId: 'retried', state: 'queued' })
    ])
    expect(readOutbox(SESSION)[0]).not.toHaveProperty('sentWhileStopping')
  })
})
