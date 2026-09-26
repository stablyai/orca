// What a Stop does to the messages this client sent that the host does not hold yet: nothing may go
// out after the Stop, and nothing the host already holds or already refused changes here.

// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  withdrawUnsentStructuredAgentSessionOutboxEntries,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'

type SendRequest = { body?: { blocks?: { text?: string }[] } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SendRequest) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { readOutbox } from './structured-agent-session-outbox-storage'

function sentTexts(): (string | undefined)[] {
  return mocks.call.mock.calls.map((call) => call[2].body?.blocks?.[0]?.text)
}

function pending(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 10,
    resolvedAt: null,
    handoverRecorded: true
  }
}

function entry(
  clientMessageId: string,
  state: StructuredAgentSessionOutboxEntry['state']
): StructuredAgentSessionOutboxEntry {
  return {
    clientMessageId,
    sessionId: 'session-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
    previewUris: [],
    state,
    queuedAt: 1,
    lastAttemptAt: null,
    retryAfterUnknownSubmittedAt: null
  }
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  let uuid = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    uuid += 1
    return `11111111-1111-4111-8111-${uuid.toString(16).padStart(12, '0')}`
  })
})

describe('a Stop withdrawing what the host does not hold', () => {
  it('keeps the send on its way and every message behind it from going out after', async () => {
    const reply = Promise.withResolvers<unknown>()
    mocks.call.mockImplementation((_target, _method, params) =>
      params.body?.blocks?.[0]?.text === 'first' ? reply.promise : new Promise<never>(() => {})
    )
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: { kind: 'local' },
        fence: 1,
        submissions: []
      })
    )
    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    act(() => expect(result.current.send('second')).toBe(true))
    const firstId = result.current.outbox[0]!.clientMessageId

    act(() => result.current.withdrawUnsent())
    await act(async () =>
      reply.resolve({
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'epoch-1', sequence: 10 },
        value: { clientMessageId: firstId, submission: pending(firstId) }
      })
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(result.current.outbox).toEqual([])
    expect(readOutbox('session-1')).toEqual([])
    expect(sentTexts()).toEqual(['first'])
  })

  it('leaves what the journal holds to the host, and a refused message to its Retry', () => {
    const entries = [
      entry('held', 'dispatching'),
      entry('refused', 'rejected'),
      entry('in-doubt', 'unconfirmed'),
      entry('local', 'queued')
    ]

    expect(
      withdrawUnsentStructuredAgentSessionOutboxEntries(entries, [pending('held')]).map(
        (candidate) => candidate.clientMessageId
      )
    ).toEqual(['held', 'refused'])
  })
})
