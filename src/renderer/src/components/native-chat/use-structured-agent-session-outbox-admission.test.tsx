// Which entry the queue dispatches next, and which one stops it.
//
// A hidden pane receives no journal updates, so `submissions` never moves and an admitted head
// stays `dispatching` for as long as the turn ahead of it runs. Delivery must not wait on that.

// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionWireRefusalCode } from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({
  call: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { enqueueStructuredAgentSessionLaunchPrompt } from './structured-agent-session-outbox-storage'
import { settleStructuredAgentLaunchPrompt } from '@/lib/structured-agent-session-launch-prompt'

const LOCAL_TARGET = { kind: 'local' } as const

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

type SendRequest = { body?: { blocks?: { text?: string }[] } }

function requestText(params: SendRequest | undefined): string | undefined {
  return params?.body?.blocks?.[0]?.text
}

function sentTexts(): (string | undefined)[] {
  return mocks.call.mock.calls.map((call) => requestText(call[2]))
}

function submissionResult(
  clientMessageId: string,
  dispatchState: 'pending' | 'accepted',
  submittedAt: number
) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: submittedAt },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState,
        providerItemId: null,
        reason: null,
        submittedAt,
        resolvedAt: dispatchState === 'accepted' ? submittedAt : null
      }
    }
  }
}

function refusedResult(code: AgentSessionWireRefusalCode) {
  return { ok: false, refusal: { code, message: code } }
}

function renderOutbox() {
  return renderHook(() =>
    useStructuredAgentSessionOutbox({
      sessionId: 'session-1',
      target: LOCAL_TARGET,
      fence: 1,
      submissions: []
    })
  )
}

async function settleTimers(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

describe('structured agent session outbox admission', () => {
  let randomUuidSequence = 0

  // Without this a hook left mounted keeps its probe timers running into the next test.
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    randomUuidSequence = 0
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
      randomUuidSequence += 1
      return `11111111-1111-4111-8111-${randomUuidSequence.toString(16).padStart(12, '0')}`
    })
  })

  it('dispatches the queued tail while the head is still pending', async () => {
    const head = deferred<ReturnType<typeof submissionResult>>()
    // A persistent implementation, so no queued `...Once` can outlive this test.
    mocks.call.mockImplementation((_target, _method, params) =>
      requestText(params) === 'first' ? head.promise : new Promise<never>(() => {})
    )
    const { result } = renderOutbox()

    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    act(() => expect(result.current.send('second')).toBe(true))
    await settleTimers(50)
    // Single-flight: the tail waits for the head's round trip, never runs beside it.
    expect(mocks.call).toHaveBeenCalledTimes(1)

    const headId = result.current.outbox[0]?.clientMessageId
    expect(headId).toBeDefined()
    await act(async () => head.resolve(submissionResult(String(headId), 'pending', 10)))

    await waitFor(() => expect(sentTexts()).toContain('second'))
    // The admitted head stays: only the journal's answer retires it, not the tail going out.
    expect(result.current.outbox).toHaveLength(2)
    expect(result.current.outbox[0]?.clientMessageId).toBe(headId)
    expect(result.current.outbox[0]?.state).toBe('dispatching')
    expect(result.current.error).toBeNull()
  })

  it('keeps an unconfirmed head blocking the queue', async () => {
    mocks.call.mockRejectedValue(new Error('socket closed'))
    const { result } = renderOutbox()

    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('unconfirmed'))
    act(() => expect(result.current.send('second')).toBe(true))
    // Well inside the unknown probe's first delay, which would otherwise requeue the head.
    await settleTimers(200)

    expect(sentTexts()).not.toContain('second')
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('keeps a refused head blocking the queue', async () => {
    mocks.call.mockResolvedValue(refusedResult('agent_session_ownership_unknown'))
    const { result } = renderOutbox()

    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(result.current.blockedClientMessageId).not.toBeNull())
    act(() => expect(result.current.send('second')).toBe(true))
    await settleTimers(200)

    expect(sentTexts()).not.toContain('second')
    expect(result.current.blockedClientMessageId).toBe(result.current.outbox[0]?.clientMessageId)
  })

  it.each(['accepted', 'pending'] as const)(
    'holds a queued message until the launch prompt returns %s',
    async (dispatchState) => {
      const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
      if (!stagedEntry) {
        throw new Error('fixture outbox entry was not persisted')
      }
      const admission = deferred<ReturnType<typeof submissionResult>>()
      mocks.call.mockImplementation((_target, _method, params) =>
        requestText(params) === 'review this' ? admission.promise : new Promise<never>(() => {})
      )
      const delivery = settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        options: { prompt: 'review this' },
        stagedEntry
      })
      await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))

      const { result } = renderOutbox()
      act(() => expect(result.current.send('after launch')).toBe(true))
      await settleTimers(50)
      // The launch settlement dispatches outside this hook's single-flight, so nothing may race it.
      expect(sentTexts()).not.toContain('after launch')

      await act(async () =>
        admission.resolve(submissionResult(stagedEntry.clientMessageId, dispatchState, 1))
      )
      await expect(delivery).resolves.toEqual({ delivered: true, failureNotified: false })

      await waitFor(() => expect(sentTexts()).toContain('after launch'))
      expect(result.current.outbox).toHaveLength(dispatchState === 'pending' ? 2 : 1)
    }
  )

  it('advances the tail when the journal admits the head before its RPC resolves', async () => {
    const admission = deferred<ReturnType<typeof submissionResult>>()
    mocks.call.mockImplementation((_target, _method, params) =>
      requestText(params) === 'first' ? admission.promise : new Promise<never>(() => {})
    )
    const submissions: readonly AgentJournalSubmission[] = []
    const { result, rerender } = renderHook(
      ({ submissions }: { submissions: readonly AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions
        }),
      { initialProps: { submissions } }
    )
    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    act(() => expect(result.current.send('second')).toBe(true))
    const id = result.current.outbox[0]?.clientMessageId
    expect(id).toBeDefined()
    rerender({ submissions: [submissionResult(String(id), 'pending', 10).value.submission] })
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second']))
    await act(async () => admission.resolve(submissionResult(String(id), 'pending', 10)))
    expect(sentTexts()).toEqual(['first', 'second'])
  })
})
