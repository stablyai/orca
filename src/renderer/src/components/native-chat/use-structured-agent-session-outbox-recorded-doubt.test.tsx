// @vitest-environment happy-dom

// A message the journal records in doubt (its child ended before answering it) leaves the outbox,
// so nothing waits on it, now or after a reopen whose loaded rows no longer reach it. A queue an
// earlier build saved stuck behind one is freed once the chat opens again, and the held message is
// never sent again.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'

const SESSION = 'session-1'
const LOCAL_TARGET = { kind: 'local' } as const

type SendRequest = { envelope?: { clientOperationId?: string } }
type SentText = { body?: { blocks?: { text?: string }[] } }

function requestId(params: SendRequest | undefined): string {
  return String(params?.envelope?.clientOperationId)
}

function sentIds(): string[] {
  return mocks.call.mock.calls.map((call) => requestId(call[2]))
}

function saved(
  clientMessageId: string,
  patch: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId,
      sessionId: SESSION,
      text: clientMessageId,
      attachments: [],
      queuedAt: 1
    }),
    ...patch
  }
}

/** What the host wrote when the child ended with the follow-up unanswered. */
const IN_DOUBT: AgentJournalSubmission = {
  clientMessageId: 'op-follow-up',
  fence: 1,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'unknown',
  providerItemId: null,
  reason: 'provider_closed_before_acknowledgement',
  submittedAt: 2,
  resolvedAt: 3,
  recovered: true
}

/** The host's answer to a send it recorded in doubt, first try or replay. */
function inDoubt(clientMessageId: string) {
  return {
    ok: true,
    replayed: clientMessageId === IN_DOUBT.clientMessageId,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 4 },
    value: { clientMessageId, submission: { ...IN_DOUBT, clientMessageId } }
  }
}

function accepted(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 4 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: `provider-${clientMessageId}`,
        reason: null,
        submittedAt: 4,
        resolvedAt: 4
      }
    }
  }
}

describe('a queue saved behind a message the host holds in doubt', () => {
  afterEach(() => {
    cleanup()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
    // The host answers a replay of the recorded follow-up with its doubt, and takes anything else.
    mocks.call.mockImplementation((_target, _method, params: SendRequest) =>
      Promise.resolve(
        requestId(params) === IN_DOUBT.clientMessageId
          ? inDoubt(requestId(params))
          : accepted(requestId(params))
      )
    )
  })

  it.each([
    ['held as unconfirmed', 'unconfirmed'],
    ['left on its way out', 'dispatching']
  ] as const)(
    'sends the message behind it when the chat opens again, the held one %s',
    async (_case, state) => {
      writeOutbox(SESSION, [saved('op-follow-up', { state, lastAttemptAt: 2 }), saved('op-next')])

      const { result } = renderHook(() =>
        useStructuredAgentSessionOutbox({
          sessionId: SESSION,
          target: LOCAL_TARGET,
          fence: 1,
          submissions: [IN_DOUBT]
        })
      )

      await waitFor(() => expect(sentIds()).toEqual(['op-next']))
      // Past the unconfirmed probe's first delay: the held message is never sent again.
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 1_200)))
      expect(sentIds()).toEqual(['op-next'])
      expect(result.current.outbox).toEqual([])
    }
  )

  // Its rows can age out of what a reopen loads; the entry left with the first reconcile.
  it('never holds a send after a reopen whose loaded rows no longer reach it', async () => {
    writeOutbox(SESSION, [saved('op-follow-up', { state: 'dispatching', lastAttemptAt: 2 })])
    const before = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: LOCAL_TARGET,
        fence: 1,
        submissions: [IN_DOUBT]
      })
    )
    await waitFor(() => expect(before.result.current.outbox).toEqual([]))
    before.unmount()

    const after = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
    )
    act(() => expect(after.result.current.send('next')).toBe(true))
    await waitFor(() => expect(after.result.current.outbox).toEqual([]))
    expect(sentIds()).toHaveLength(1)
    expect(sentIds()).not.toContain(IN_DOUBT.clientMessageId)
  })

  // A client that never loaded the row: the probe's replay is the host's answer that it has it.
  it('frees a queue whose message in doubt was recorded out of sight, by the replay', async () => {
    writeOutbox(SESSION, [
      saved('op-follow-up', { state: 'unconfirmed', lastAttemptAt: 2 }),
      saved('op-next')
    ])
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
    )

    await waitFor(() => expect(sentIds()).toEqual(['op-follow-up', 'op-next']), {
      timeout: 5_000
    })
    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(result.current.error).toBeNull()
  })

  // The one the host holds leaves; the probe resends the one it may not have.
  it('probes a message the host may never have received, saved behind one it holds', async () => {
    writeOutbox(SESSION, [
      saved('op-follow-up', { state: 'unconfirmed', lastAttemptAt: 2 }),
      saved('op-lost', { state: 'unconfirmed', lastAttemptAt: 3 }),
      saved('op-next')
    ])

    renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: LOCAL_TARGET,
        fence: 1,
        submissions: [IN_DOUBT]
      })
    )

    await waitFor(() => expect(sentIds()).toEqual(['op-lost', 'op-next']), { timeout: 5_000 })
  })

  it('holds the queue until the journal shows the host has it, then sends what waits', async () => {
    // Retried once already, so the probe leaves it alone and only the journal can free the queue.
    writeOutbox(SESSION, [
      saved('op-follow-up', {
        state: 'unconfirmed',
        lastAttemptAt: 2,
        retryAfterUnknownSubmittedAt: -1
      }),
      saved('op-next')
    ])
    const { rerender } = renderHook(
      ({ submissions }: { submissions: readonly AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: SESSION,
          target: LOCAL_TARGET,
          fence: 1,
          submissions
        }),
      { initialProps: { submissions: [] as readonly AgentJournalSubmission[] } }
    )
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 100)))
    expect(sentIds()).toEqual([])

    rerender({ submissions: [IN_DOUBT] })
    await waitFor(() => expect(sentIds()).toEqual(['op-next']))
  })

  it('drops a send the host answers in doubt, and sends what follows it at once', async () => {
    mocks.call.mockImplementation((_target, _method, params: SendRequest & SentText) =>
      Promise.resolve(
        params.body?.blocks?.[0]?.text === 'first'
          ? inDoubt(requestId(params))
          : accepted(requestId(params))
      )
    )
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
    )

    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(result.current.outbox).toEqual([]))
    act(() => expect(result.current.send('second')).toBe(true))
    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(sentIds()).toHaveLength(2)
    expect(result.current.error).toBeNull()
  })

  // A Retry an earlier build saved on this very submission waits for its answer: the host refuses
  // to send it again, and the user is told to check the chat before sending it again.
  it('drops a saved Retry of a recorded doubt once the host only replays it', async () => {
    writeOutbox(SESSION, [
      saved(IN_DOUBT.clientMessageId, {
        lastAttemptAt: 2,
        retryAfterUnknownSubmittedAt: IN_DOUBT.submittedAt
      })
    ])
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: LOCAL_TARGET,
        fence: 1,
        submissions: [IN_DOUBT]
      })
    )

    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(sentIds()).toEqual([IN_DOUBT.clientMessageId])
    expect(result.current.error).toBe(
      "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."
    )
  })
})
