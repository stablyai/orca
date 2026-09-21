// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionWireRefusalCode } from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({
  call: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

const LOCAL_TARGET = { kind: 'local' } as const

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function acceptedResult(fence: number) {
  return {
    ok: true,
    replayed: false,
    fence,
    cursor: { epoch: 'epoch-1', sequence: fence },
    value: {
      clientMessageId: 'client-1',
      submission: {
        clientMessageId: 'client-1',
        fence,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: 'provider-1',
        reason: null,
        submittedAt: fence,
        resolvedAt: fence
      }
    }
  }
}

function acceptedResultFor(clientMessageId: string, fence: number) {
  return {
    ok: true,
    replayed: false,
    fence,
    cursor: { epoch: 'epoch-1', sequence: fence },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: `provider-${clientMessageId}`,
        reason: null,
        submittedAt: fence,
        resolvedAt: fence
      }
    }
  }
}

function unknownResultFor(clientMessageId: string, submittedAt: number) {
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
        dispatchState: 'unknown' as const,
        providerItemId: null,
        reason: 'socket closed',
        submittedAt,
        resolvedAt: submittedAt
      }
    }
  }
}

function refusedResult(code: AgentSessionWireRefusalCode) {
  return { ok: false, refusal: { code, message: code } }
}

describe('useStructuredAgentSessionOutbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111'
    )
  })

  it('requeues across a fence change and ignores the stale settlement', async () => {
    const first = deferred<ReturnType<typeof acceptedResult>>()
    const second = deferred<ReturnType<typeof acceptedResult>>()
    mocks.call.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(
      ({ fence }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence,
          submissions: []
        }),
      { initialProps: { fence: 1 } }
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))

    rerender({ fence: 2 })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(mocks.call.mock.calls[1]?.[2]).toMatchObject({
      envelope: { expectedRuntimeFence: 2 }
    })

    await act(async () => first.resolve(acceptedResult(1)))
    expect(result.current.outbox).toHaveLength(1)

    await act(async () => second.resolve(acceptedResult(2)))
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
  })

  it.each(['agent_session_operation_conflict', 'agent_session_operation_expired'] as const)(
    'rotates a send operation after %s',
    async (code) => {
      vi.mocked(globalThis.crypto.randomUUID)
        .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
        .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
      mocks.call.mockResolvedValueOnce(refusedResult(code)).mockResolvedValueOnce(acceptedResult(1))
      const { result } = renderHook(() =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions: []
        })
      )

      act(() => expect(result.current.send('hello')).toBe(true))
      await waitFor(() => expect(result.current.outbox[0]?.state).toBe('queued'))
      const firstId = (mocks.call.mock.calls[0]![2] as { envelope: { clientOperationId: string } })
        .envelope.clientOperationId
      const retryId = result.current.outbox[0]!.clientMessageId
      expect(retryId).not.toBe(firstId)

      act(() => result.current.retry(retryId))
      await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
      expect(
        (mocks.call.mock.calls[1]![2] as { envelope: { clientOperationId: string } }).envelope
          .clientOperationId
      ).toBe(retryId)
    }
  )

  it('retains a send operation after a pending-admission refusal', async () => {
    mocks.call
      .mockResolvedValueOnce(refusedResult('agent_session_checkpoint_stale'))
      .mockResolvedValueOnce(acceptedResult(1))
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('queued'))
    const firstId = (mocks.call.mock.calls[0]![2] as { envelope: { clientOperationId: string } })
      .envelope.clientOperationId
    expect(result.current.outbox[0]?.clientMessageId).toBe(firstId)

    act(() => result.current.retry(firstId))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(
      (mocks.call.mock.calls[1]![2] as { envelope: { clientOperationId: string } }).envelope
        .clientOperationId
    ).toBe(firstId)
  })

  it('persists and dispatches an attachment-only structured send', async () => {
    mocks.call.mockResolvedValue(acceptedResult(1))
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
    )

    act(() =>
      expect(
        result.current.send('', [{ path: '/tmp/image.png', previewUri: 'file:///tmp/image.png' }])
      ).toBe(true)
    )
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'image-ref', path: '/tmp/image.png' }]
      }
    })
  })

  it('retries an unknown head and advances a queued tail', async () => {
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReturnValueOnce('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      .mockReturnValueOnce('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    mocks.call
      .mockImplementationOnce(async (_target, _method, params) => {
        const clientMessageId = (params as { envelope: { clientOperationId: string } }).envelope
          .clientOperationId
        return unknownResultFor(clientMessageId, 10)
      })
      .mockImplementationOnce(async (_target, _method, params) => {
        const clientMessageId = (params as { envelope: { clientOperationId: string } }).envelope
          .clientOperationId
        return acceptedResultFor(clientMessageId, 11)
      })
      .mockImplementationOnce(async (_target, _method, params) => {
        const clientMessageId = (params as { envelope: { clientOperationId: string } }).envelope
          .clientOperationId
        return acceptedResultFor(clientMessageId, 12)
      })
    const { result, rerender } = renderHook(
      ({ submissions }: { submissions: readonly AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions
        }),
      { initialProps: { submissions: [] as readonly AgentJournalSubmission[] } }
    )

    act(() => {
      expect(result.current.send('first')).toBe(true)
    })
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('unconfirmed'))
    const firstId = result.current.outbox[0]!.clientMessageId
    rerender({
      submissions: [
        {
          clientMessageId: firstId,
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'unknown',
          providerItemId: null,
          reason: 'socket closed',
          submittedAt: 10,
          resolvedAt: 10
        }
      ]
    })
    act(() => {
      expect(result.current.send('second')).toBe(true)
    })
    expect(result.current.outbox).toHaveLength(2)

    act(() => result.current.retry(firstId))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    const retryParams = mocks.call.mock.calls[1]?.[2] as { retryUnknown?: true } | undefined
    expect(retryParams?.retryUnknown).toBe(true)
  })

  it('rotates a history-rejected unknown head so the queued tail can advance', async () => {
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReturnValueOnce('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      .mockReturnValueOnce('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
      .mockReturnValueOnce('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    mocks.call
      .mockImplementationOnce(async (_target, _method, params) => {
        const clientMessageId = (params as { envelope: { clientOperationId: string } }).envelope
          .clientOperationId
        return unknownResultFor(clientMessageId, 10)
      })
      .mockImplementationOnce(async (_target, _method, params) => {
        const clientMessageId = (params as { envelope: { clientOperationId: string } }).envelope
          .clientOperationId
        return acceptedResultFor(clientMessageId, 11)
      })
      .mockImplementationOnce(async (_target, _method, params) => {
        const clientMessageId = (params as { envelope: { clientOperationId: string } }).envelope
          .clientOperationId
        return acceptedResultFor(clientMessageId, 12)
      })
    const { result, rerender } = renderHook(
      ({ submissions }: { submissions: readonly AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions
        }),
      { initialProps: { submissions: [] as readonly AgentJournalSubmission[] } }
    )

    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('unconfirmed'))
    const firstId = result.current.outbox[0]!.clientMessageId
    act(() => expect(result.current.send('second')).toBe(true))
    rerender({
      submissions: [
        {
          clientMessageId: firstId,
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'rejected',
          providerItemId: null,
          reason: 'not_delivered',
          submittedAt: 10,
          resolvedAt: 10
        }
      ]
    })

    act(() => result.current.retry(firstId))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    const retryParams = mocks.call.mock.calls[1]?.[2] as
      | { envelope: { clientOperationId: string } }
      | undefined
    expect(retryParams?.envelope.clientOperationId).not.toBe(firstId)
  })

  it('loads the new session outbox when a pane switches sessions', async () => {
    mocks.call.mockImplementationOnce(async (_target, _method, params) => {
      const clientMessageId = (params as { envelope: { clientOperationId: string } }).envelope
        .clientOperationId
      return unknownResultFor(clientMessageId, 10)
    })

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useStructuredAgentSessionOutbox({
          sessionId,
          target: LOCAL_TARGET,
          fence: 1,
          submissions: []
        }),
      { initialProps: { sessionId: 'session-1' } }
    )

    act(() => expect(result.current.send('first session')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('unconfirmed'))

    rerender({ sessionId: 'session-2' })
    expect(result.current.outbox).toHaveLength(0)

    act(() => expect(result.current.send('second session')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(mocks.call.mock.calls[1]?.[2]).toMatchObject({
      envelope: { sessionId: 'session-2' },
      body: {
        blocks: [{ type: 'text', text: 'second session' }]
      }
    })
  })

  it('drops a session error on switch and does not resurrect it on return', async () => {
    const redispatch = deferred<ReturnType<typeof acceptedResult>>()
    mocks.call
      .mockResolvedValueOnce(refusedResult('agent_session_checkpoint_stale'))
      .mockReturnValueOnce(redispatch.promise)
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useStructuredAgentSessionOutbox({
          sessionId,
          target: LOCAL_TARGET,
          fence: 1,
          submissions: []
        }),
      { initialProps: { sessionId: 'session-1' } }
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.error).toBe('agent_session_checkpoint_stale'))

    rerender({ sessionId: 'session-2' })
    expect(result.current.error).toBeNull()

    rerender({ sessionId: 'session-1' })
    expect(result.current.error).toBeNull()
  })

  it('invalidates an old dispatch before it settles during a session switch', async () => {
    const oldDispatch = deferred<ReturnType<typeof refusedResult>>()
    const sessionTwoCommitted = deferred<void>()
    mocks.call.mockReturnValueOnce(oldDispatch.promise)
    const controllerRef: {
      current: ReturnType<typeof useStructuredAgentSessionOutbox> | null
    } = { current: null }
    function Probe({ sessionId }: { sessionId: string }): null {
      controllerRef.current = useStructuredAgentSessionOutbox({
        sessionId,
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
      useLayoutEffect(() => {
        if (sessionId === 'session-2') {
          oldDispatch.resolve(refusedResult('agent_session_checkpoint_stale'))
          sessionTwoCommitted.resolve()
        }
      }, [sessionId])
      return null
    }

    const container = document.createElement('div')
    const root = createRoot(container)
    const actEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    try {
      await act(async () => root.render(<Probe sessionId="session-1" />))
      act(() => expect(controllerRef.current?.send('hello')).toBe(true))
      await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
      const oldSettlementProcessed = oldDispatch.promise.then(() => undefined)

      globalThis.IS_REACT_ACT_ENVIRONMENT = false
      root.render(<Probe sessionId="session-2" />)
      await sessionTwoCommitted.promise
      globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment
      await act(async () => oldSettlementProcessed)

      expect(controllerRef.current?.error).toBeNull()
      await act(async () => root.render(<Probe sessionId="session-1" />))
      expect(controllerRef.current?.error).toBeNull()
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment
      await act(async () => root.unmount())
    }
  })
})
