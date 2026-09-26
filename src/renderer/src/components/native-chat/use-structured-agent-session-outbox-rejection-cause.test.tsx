// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

// What the host answers when the child it restarted for this send died before starting.
const REASON =
  'The provider stopped before it finished starting: claude stream-json exited (code 1): claude: not signed in.'

function rejectedResultFor(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 3,
    cursor: { epoch: 'epoch-1', sequence: 4 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 3,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'rejected',
        providerItemId: null,
        reason: REASON,
        submittedAt: 10,
        resolvedAt: 11
      }
    }
  }
}

describe('a send the host rejected because the agent never started', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('names the cause on the message and keeps it for Retry', async () => {
    mocks.call.mockImplementationOnce(
      async (
        _target: unknown,
        _method: unknown,
        params: { envelope: { clientOperationId: string } }
      ) => rejectedResultFor(params.envelope.clientOperationId)
    )
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: { kind: 'local' },
        fence: 1,
        submissions: []
      })
    )

    act(() => expect(result.current.send('hello')).toBe(true))

    await waitFor(() => expect(result.current.outbox[0]?.notice).toBe(REASON))
    expect(result.current.outbox[0]?.state).toBe('queued')
    expect(result.current.blockedClientMessageId).toBe(result.current.outbox[0]?.clientMessageId)
  })
})

// Stable across renders, as a mounted pane's target is.
const LOCAL_TARGET = { kind: 'local' } as const

function acceptedResultFor(clientMessageId: string) {
  const rejected = rejectedResultFor(clientMessageId)
  return {
    ...rejected,
    value: {
      clientMessageId,
      submission: { ...rejected.value.submission, dispatchState: 'accepted', reason: null }
    }
  }
}

describe('a send refused while its agent restarted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('leaves no error behind once a send refused before an agent restart is delivered', async () => {
    let deliver!: (value: unknown) => void
    const resend = {
      promise: new Promise((resolve) => (deliver = resolve)),
      resolve: (value: unknown) => deliver(value)
    }
    mocks.call
      .mockResolvedValueOnce({
        ok: false,
        refusal: {
          code: 'agent_session_checkpoint_stale',
          message: 'Expected runtime fence 1; the session is at 3.'
        }
      })
      .mockReturnValueOnce(resend.promise)
    const { result, rerender } = renderHook(
      ({ fence }: { fence: number }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence,
          submissions: []
        }),
      { initialProps: { fence: 1 } }
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() =>
      expect(result.current.outbox[0]?.notice).toBe(
        'The agent was restarting. Your message was not sent. Retry to send it again.'
      )
    )

    // The pane learns the new owner and sends the same message again.
    rerender({ fence: 3 })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(result.current.outbox[0]).toMatchObject({ state: 'dispatching' })
    expect(result.current.outbox[0]?.notice).toBeUndefined()

    resend.resolve(acceptedResultFor(result.current.outbox[0]!.clientMessageId))
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    expect(result.current.error).toBeNull()
    expect(result.current.blockedClientMessageId).toBeNull()
  })
})
