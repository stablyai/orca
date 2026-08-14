// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionWireRefusalCode } from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({
  call: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'

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

  it('persists one edit authority and binds it into the durable fingerprint', async () => {
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
        result.current.send('change one file', {
          effectAuthority: 'local_structured_write'
        })
      ).toBe(true)
    )
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    const request = mocks.call.mock.calls[0]?.[2] as {
      body: unknown
      effectAuthority: 'local_structured_write'
      envelope: { sessionId: string; payloadFingerprint: string }
    }
    expect(request.effectAuthority).toBe('local_structured_write')
    expect(request.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: request.envelope.sessionId,
        fields: { body: request.body, effectAuthority: request.effectAuthority }
      })
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
    'rotates a send operation after %s without dropping edit authority',
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

      act(() =>
        expect(
          result.current.send('change one file', {
            effectAuthority: 'local_structured_write'
          })
        ).toBe(true)
      )
      await waitFor(() => expect(result.current.outbox[0]?.state).toBe('queued'))
      const firstId = (mocks.call.mock.calls[0]![2] as { envelope: { clientOperationId: string } })
        .envelope.clientOperationId
      const retry = result.current.outbox[0]!
      expect(retry.clientMessageId).not.toBe(firstId)
      expect(retry.effectAuthority).toBe('local_structured_write')

      act(() => result.current.retry(retry.clientMessageId))
      await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
      expect(mocks.call.mock.calls[1]![2]).toMatchObject({
        effectAuthority: 'local_structured_write',
        envelope: { clientOperationId: retry.clientMessageId }
      })
    }
  )

  it('retains an operation after a pending-admission refusal', async () => {
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
    expect(mocks.call.mock.calls[1]![2]).toMatchObject({
      envelope: { clientOperationId: firstId }
    })
  })
})
