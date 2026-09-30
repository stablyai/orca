// @vitest-environment happy-dom

// A queued follow-up whose answer is out survives a Stop, since the host may hold it as a paused
// card. From then on only the user's Retry sends it: the unconfirmed probe resending it onto the
// now-idle session would start a turn the user just stopped.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

type SentParams = { envelope: { clientOperationId: string }; delivery?: string }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SentParams) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'

const TARGET = { kind: 'local' } as const
const REMOTE = { kind: 'environment', environmentId: 'env-1' } as const
const NOT_ATTACHED: { fence: number | null } = { fence: null }

beforeEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  mocks.call.mockReset()
  mocks.call.mockImplementation(() => new Promise(() => {}))
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('a Stop with a queued send in doubt', () => {
  it('a remote send probed back to queued after a lost answer: Stop keeps it for Retry', async () => {
    // Lost answer, a re-probe that failed (capability unknown), and the probe flipped the entry
    // back to `queued`; the Stop lands before the drain sends it again.
    writeOutbox('session-1', [
      {
        ...createStructuredAgentSessionOutboxEntry({
          clientMessageId: 'probed',
          sessionId: 'session-1',
          text: 'follow-up',
          attachments: [],
          queuedAt: 1
        }),
        sentDelivery: 'queue-if-active',
        lastAttemptAt: 5,
        state: 'queued'
      }
    ])
    const view = renderHook(
      (props: { fence: number | null }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: REMOTE,
          fence: props.fence,
          submissions: [],
          composerScopeKey: 'scope',
          queueDelivery: { capability: 'unknown', enabled: true }
        }),
      { initialProps: NOT_ATTACHED }
    )
    act(() => {
      view.result.current.withdrawUnsent()
    })
    // The host may hold it as a paused card: the composer gets nothing.
    expect(readNativeChatDraftCache('scope')).toBe('')
    // Marked, state untouched: the mark alone holds it.
    expect(view.result.current.outbox.map((entry) => [entry.state, entry.outlivedStop])).toEqual([
      ['queued', true]
    ])
    view.rerender({ fence: 1 })
    // Past the probe's longest backoff several times over.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mocks.call).not.toHaveBeenCalled()
    expect(readOutbox('session-1').map((entry) => entry.clientMessageId)).toEqual(['probed'])

    act(() => {
      view.result.current.retry('probed')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    // The same operation with what it first sent, though the capability is still unknown.
    expect(mocks.call.mock.calls.map((call) => call[2].envelope.clientOperationId)).toEqual([
      'probed'
    ])
    expect(mocks.call.mock.calls[0]?.[2].delivery).toBe('queue-if-active')
  })

  it('never resends one a Stop found in flight whose answer later comes back unknown', async () => {
    const answer = Promise.withResolvers<unknown>()
    mocks.call.mockImplementationOnce(() => answer.promise)
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: TARGET,
        fence: 1,
        submissions: [],
        composerScopeKey: 'scope',
        queueDelivery: { capability: 'supported' as const, enabled: true }
      })
    )
    act(() => {
      result.current.send('follow-up')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mocks.call).toHaveBeenCalledTimes(1)
    const id = mocks.call.mock.calls[0]?.[2].envelope.clientOperationId ?? ''
    act(() => {
      result.current.withdrawUnsent()
    })
    // The transport loses the answer: delivery unknown, after the Stop.
    await act(async () => {
      answer.reject(new Error('connection closed'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.outbox.map((entry) => entry.state)).toEqual(['unconfirmed'])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mocks.call).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.retry(id)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mocks.call.mock.calls.map((call) => call[2].envelope.clientOperationId)).toEqual([
      id,
      id
    ])
  })

  it('the drain never sends one a Stop outlived, even after a reload left it queued', async () => {
    writeOutbox('session-1', [
      {
        ...createStructuredAgentSessionOutboxEntry({
          clientMessageId: 'outlived',
          sessionId: 'session-1',
          text: 'follow-up',
          attachments: [],
          queuedAt: 1
        }),
        sentDelivery: 'queue-if-active',
        lastAttemptAt: 5,
        outlivedStop: true,
        state: 'queued'
      }
    ])
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: TARGET,
        fence: 1,
        submissions: [],
        queueDelivery: { capability: 'supported', enabled: true }
      })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mocks.call).not.toHaveBeenCalled()
    // Held by the mark alone; its state, and so its notice, stays what its answer made it.
    expect(result.current.outbox.map((entry) => entry.state)).toEqual(['queued'])
  })
})
