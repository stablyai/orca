// @vitest-environment happy-dom

// The outbox re-reads the journal on every batch; a batch that settles nothing writes nothing, so a
// message left in doubt costs no storage write per streamed delta. And a copy the host recorded and
// rejected owes no delivery, so it keeps no hidden pane reading the journal.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(() => new Promise(() => {}))
}))

import {
  hasUndeliveredStructuredAgentSessionOutbox,
  writeOutbox
} from './structured-agent-session-outbox-storage'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
})

const SESSION = 'session-churn'

function stored(
  id: string,
  patch: Partial<ReturnType<typeof createStructuredAgentSessionOutboxEntry>>
) {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: id,
      sessionId: SESSION,
      text: id,
      attachments: [],
      queuedAt: 1
    }),
    ...patch
  }
}

function inDoubt(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'unknown',
    providerItemId: null,
    reason: 'in doubt',
    submittedAt: 5,
    resolvedAt: 6
  }
}

function streamed(sequence: number): AgentJournalRenderItem[] {
  return [
    {
      itemId: `answer-${sequence}`,
      revision: sequence,
      sequence,
      observedAt: sequence,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'streaming' }] }
    }
  ]
}

it('writes nothing to storage across 50 batches while a message waits in doubt', async () => {
  writeOutbox(SESSION, [stored('doubt', { state: 'dispatching', lastAttemptAt: 2 })])
  const { rerender } = renderHook(
    (props: { items: AgentJournalRenderItem[]; submissions: AgentJournalSubmission[] }) =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: { kind: 'local' },
        fence: 1,
        submissions: props.submissions,
        journalItems: props.items
      }),
    { initialProps: { items: streamed(1), submissions: [inDoubt('doubt')] } }
  )
  await act(async () => {})
  const writes = vi.spyOn(localStorage, 'setItem')

  for (let sequence = 2; sequence <= 51; sequence += 1) {
    // Each batch is a new journal array and a new submissions array with the same content.
    rerender({ items: streamed(sequence), submissions: [inDoubt('doubt')] })
  }
  await act(async () => {})

  expect(writes).not.toHaveBeenCalled()
  writes.mockRestore()
})

it('counts a copy the host recorded and rejected as owing no delivery', () => {
  writeOutbox(SESSION, [
    stored('recorded', {
      state: 'rejected',
      lastFailure: { kind: 'rejected', reason: 'Orca restarted before this message was sent.' }
    })
  ])
  expect(hasUndeliveredStructuredAgentSessionOutbox(SESSION)).toBe(false)

  writeOutbox(SESSION, [
    stored('recorded', {
      state: 'rejected',
      lastFailure: { kind: 'rejected', reason: 'Orca restarted before this message was sent.' }
    }),
    stored('waiting', {})
  ])
  expect(hasUndeliveredStructuredAgentSessionOutbox(SESSION)).toBe(true)
})
