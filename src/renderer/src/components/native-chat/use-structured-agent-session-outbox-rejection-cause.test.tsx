// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { DISPATCH_REJECTED_CANCELLED } from '../../../../shared/structured-agent-session-dispatch-rejection'

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

function acceptedResultFor(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 2 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: `provider-${clientMessageId}`,
        reason: null,
        submittedAt: 1,
        resolvedAt: 1
      }
    }
  }
}

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

  it('names the cause under the composer and keeps the message for Retry', async () => {
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

    await waitFor(() => expect(result.current.error).toBe(REASON))
    // Settled as not delivered: it waits for Retry and holds no later message up.
    expect(result.current.outbox[0]?.state).toBe('rejected')
    expect(result.current.blockedClientMessageId).toBeNull()
  })

  it('sends a new message past one the host could not start the agent for, without resending it', async () => {
    const message = "Claude couldn't restart: Not logged in. Please run /login."
    mocks.call.mockImplementation(async (_target, _method, params) => {
      const request = params as {
        envelope: { clientOperationId: string }
        body: { blocks: { text?: string }[] }
      }
      return request.body.blocks[0]?.text === 'first'
        ? { ok: false, refusal: { code: 'agent_session_owner_restart_failed', message } }
        : acceptedResultFor(request.envelope.clientOperationId)
    })
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: { kind: 'local' },
        fence: 1,
        submissions: []
      })
    )

    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('rejected'))
    const rejectedId = result.current.outbox[0]!.clientMessageId

    // The user's next message is the retry of the start: it goes out on its own.
    act(() => expect(result.current.send('second')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    const sent = mocks.call.mock.calls.map(
      (call) => (call[2] as { body?: { blocks?: { text?: string }[] } })?.body?.blocks?.[0]?.text
    )
    expect(sent).toEqual(['first', 'second'])
    expect(result.current.outbox.map((entry) => [entry.clientMessageId, entry.state])).toEqual([
      [rejectedId, 'rejected']
    ])
  })

  it('keeps a message the host accepted and then could not deliver, with its reason and Retry', async () => {
    const reason = "Codex couldn't restart: spawn codex ENOENT."
    mocks.call.mockImplementation(
      async (
        _target: unknown,
        _method: unknown,
        params: { envelope: { clientOperationId: string } }
      ) => pendingResultFor(params.envelope.clientOperationId)
    )
    const target = { kind: 'local' } as const
    const { result, rerender } = renderHook(
      (props: { submissions: AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target,
          fence: 1,
          submissions: props.submissions
        }),
      { initialProps: { submissions: NO_SUBMISSIONS } }
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('dispatching'))
    const id = result.current.outbox[0]!.clientMessageId

    rerender({
      submissions: [{ ...pendingResultFor(id).value.submission, dispatchState: 'rejected', reason }]
    })

    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('rejected'))
    expect(result.current.error).toBe(reason)
    expect(result.current.blockedClientMessageId).toBeNull()

    // Retry is a new message with the same text: a fresh id, sent once.
    act(() => result.current.retry(id))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    const retried: {
      envelope: { clientOperationId: string }
      body: { blocks: { text?: string }[] }
    } = mocks.call.mock.calls[1]![2]
    expect(retried.envelope.clientOperationId).not.toBe(id)
    expect(retried.body.blocks[0]?.text).toBe('hello')
  })

  it('says nothing when a Stop withdrew the message', async () => {
    mocks.call.mockImplementation(
      async (
        _target: unknown,
        _method: unknown,
        params: { envelope: { clientOperationId: string } }
      ) => pendingResultFor(params.envelope.clientOperationId)
    )
    const target = { kind: 'local' } as const
    const { result, rerender } = renderHook(
      (props: { submissions: AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target,
          fence: 1,
          submissions: props.submissions
        }),
      { initialProps: { submissions: NO_SUBMISSIONS } }
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('dispatching'))
    const id = result.current.outbox[0]!.clientMessageId

    rerender({
      submissions: [
        {
          ...pendingResultFor(id).value.submission,
          dispatchState: 'rejected',
          reason: DISPATCH_REJECTED_CANCELLED
        }
      ]
    })

    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(result.current.error).toBeNull()
  })

  it('reads a message rejected while the chat was closed as not sent, and sends past it', async () => {
    const reason = "Codex couldn't restart: spawn codex ENOENT."
    mocks.call.mockImplementation(
      async (
        _target: unknown,
        _method: unknown,
        params: { envelope: { clientOperationId: string } }
      ) => pendingResultFor(params.envelope.clientOperationId)
    )
    const target = { kind: 'local' } as const
    const first = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target,
        fence: 1,
        submissions: NO_SUBMISSIONS
      })
    )
    act(() => expect(first.result.current.send('hello')).toBe(true))
    await waitFor(() => expect(first.result.current.outbox[0]?.state).toBe('dispatching'))
    const id = first.result.current.outbox[0]!.clientMessageId
    first.unmount()

    // Reopened after the start failed, or after a quit settled the message as not sent.
    const rejected = [
      { ...pendingResultFor(id).value.submission, dispatchState: 'rejected' as const, reason }
    ]
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target,
        fence: 1,
        submissions: rejected
      })
    )

    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('rejected'))
    act(() => expect(result.current.send('second')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
  })

  it('keeps the rejection when the journal settles the message before the send answers', async () => {
    const reason = "Codex couldn't restart: spawn codex ENOENT."
    let answer: (value: unknown) => void = () => undefined
    mocks.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const target = { kind: 'local' } as const
    const { result, rerender } = renderHook(
      (props: { submissions: AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target,
          fence: 1,
          submissions: props.submissions
        }),
      { initialProps: { submissions: NO_SUBMISSIONS } }
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('dispatching'))
    const id = result.current.outbox[0]!.clientMessageId

    // A start refused at once: the rejection frame lands before the send's own `pending` answer.
    rerender({
      submissions: [{ ...pendingResultFor(id).value.submission, dispatchState: 'rejected', reason }]
    })
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('rejected'))
    await act(async () => answer(pendingResultFor(id)))

    expect(result.current.outbox[0]?.state).toBe('rejected')
    expect(result.current.error).toBe(reason)
  })
})

const NO_SUBMISSIONS: AgentJournalSubmission[] = []

function pendingResultFor(clientMessageId: string) {
  const submission: AgentJournalSubmission = {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    handoverRecorded: true
  }
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 2 },
    value: {
      clientMessageId,
      submission
    }
  }
}
