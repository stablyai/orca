// @vitest-environment happy-dom

// A moved fence is not a reason to send anything again on a host that records every send before it
// starts an agent. There, only a Retry or a new send goes out. An older host, which restarts the
// agent inside the send and refuses it unrecorded when that fails, keeps the resend on a new fence.

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

const LOCAL_TARGET = { kind: 'local' } as const

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function pendingResult(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'pending' as const,
        handoverRecorded: true,
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    }
  }
}

function sentId(call: number): string {
  const id: unknown = mocks.call.mock.calls[call]?.[2].envelope.clientOperationId
  return String(id)
}

function render() {
  return renderHook(
    ({ fence }) =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence,
        submissions: []
      }),
    { initialProps: { fence: 1 } }
  )
}

/** Long enough for any effect a fence change schedules to have sent. */
async function settle(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
}

describe('an outbox on a host that accepts a send before any agent has it', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
  })

  it('neither resends nor drops the answer of a send in flight when the fence moves', async () => {
    const answer = deferred<ReturnType<typeof pendingResult>>()
    mocks.call.mockReturnValueOnce(answer.promise)
    const { result, rerender } = render()

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    // A start or restart on the host moves the fence while the send is out.
    rerender({ fence: 2 })
    rerender({ fence: 3 })
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(1)

    await act(async () => answer.resolve(pendingResult(sentId(0))))
    // The answer lands: the entry is the host's now, not re-queued behind a moved fence.
    expect(result.current.outbox).toMatchObject([{ state: 'dispatching' }])
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('keeps a blocked head blocked across a fence change; only Retry sends it', async () => {
    mocks.call.mockRejectedValueOnce(new Error('send failed')).mockResolvedValue({ ok: true })
    const { result, rerender } = render()

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.blockedClientMessageId).not.toBeNull())
    rerender({ fence: 2 })
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBe('Error: send failed')

    act(() => result.current.retry(result.current.outbox[0]!.clientMessageId))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
  })
})

describe('an outbox on an older host', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([])
  })

  it('still resends a send in flight when the fence moves, as the new owner may take it', async () => {
    mocks.call.mockReturnValueOnce(new Promise(() => {})).mockReturnValue(new Promise(() => {}))
    const { result, rerender } = render()

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    rerender({ fence: 2 })

    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(sentId(1)).toBe(sentId(0))
  })
})
