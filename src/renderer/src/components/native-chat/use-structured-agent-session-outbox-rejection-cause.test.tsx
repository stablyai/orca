// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { DISPATCH_REJECTED_CANCELLED } from '../../../../shared/structured-agent-session-dispatch-rejection'

const mocks = vi.hoisted(() => ({
  call: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { agentSessionWriteNoticeEnglish } from '../../../../shared/agent-session-refusal-notice'
import { structuredAgentSessionAttemptFailureParts } from '../../../../shared/structured-agent-session-send-disposition'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'

// Why: every hook here shares the session outbox store; one left mounted would drain the next test's.
afterEach(cleanup)

function shownFailure(entry: StructuredAgentSessionOutboxEntry | undefined): string | undefined {
  return (
    entry?.lastFailure &&
    agentSessionWriteNoticeEnglish(structuredAgentSessionAttemptFailureParts(entry.lastFailure))
  )
}

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

    await waitFor(() => expect(shownFailure(result.current.outbox[0])).toBe(REASON))
    // Settled as not delivered: it waits for Retry and holds no later message up.
    expect(result.current.error).toBeNull()
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
    expect(shownFailure(result.current.outbox[0])).toBe(reason)
    expect(result.current.error).toBeNull()
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
    expect(shownFailure(result.current.outbox[0])).toBe(reason)
    act(() => expect(result.current.send('second')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
  })

  // After a restart nothing in memory remembers the rejection, and its journal row may be older
  // than the loaded page: the message's own state is what says a resend needs a new id.
  it('retries a message rejected before a restart under a new id', async () => {
    const rejected = createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'rejected-before-restart',
      sessionId: 'session-1',
      text: 'first',
      attachments: [],
      queuedAt: 1
    })
    writeOutbox('session-1', [
      {
        ...rejected,
        state: 'rejected',
        lastFailure: {
          kind: 'rejected',
          reason: 'The provider did not accept this message.',
          rejection: { kind: 'providerRejected' }
        }
      }
    ])
    mocks.call.mockImplementation(async (_target, _method, params) =>
      acceptedResultFor(String(params.envelope.clientOperationId))
    )
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: { kind: 'local' },
        fence: 1,
        submissions: []
      })
    )
    expect(result.current.outbox[0]?.state).toBe('rejected')

    act(() => result.current.retry('rejected-before-restart'))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const sentId: unknown = mocks.call.mock.calls[0]![2].envelope.clientOperationId
    expect(sentId).not.toBe('rejected-before-restart')
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
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
    expect(shownFailure(result.current.outbox[0])).toBe(reason)
    expect(result.current.error).toBeNull()
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

// Stable across renders, as a mounted pane's target is.
const LOCAL_TARGET = { kind: 'local' } as const

function submission(
  clientMessageId: string,
  dispatchState: 'pending' | 'accepted'
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 3,
    payloadFingerprint: 'fingerprint',
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 10,
    resolvedAt: dispatchState === 'accepted' ? 11 : null
  }
}

// An older host: it restarts the agent inside the send, so a new fence is its word to send again.
describe('a send refused while its agent restarted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([])
  })

  afterEach(() => {
    setLocalRuntimeCapabilitiesForTests(null)
  })

  // The live order: the restart takes seconds, so the journal settles the resend before its reply.
  it('leaves no error behind once a send refused before an agent restart is delivered', async () => {
    mocks.call
      .mockResolvedValueOnce({
        ok: false,
        refusal: {
          code: 'agent_session_checkpoint_stale',
          message: 'Expected runtime fence 1; the session is at 3.'
        }
      })
      .mockReturnValueOnce(new Promise(() => {}))
    const { result, rerender } = renderHook(
      ({ fence, submissions }: { fence: number; submissions: AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence,
          submissions
        }),
      { initialProps: { fence: 1, submissions: NO_SUBMISSIONS } }
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() =>
      expect(shownFailure(result.current.outbox[0])).toBe('Your message was not sent.')
    )

    // The pane learns the new owner and sends the same message again.
    rerender({ fence: 3, submissions: [] })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(result.current.outbox[0]).toMatchObject({ state: 'dispatching' })
    expect(shownFailure(result.current.outbox[0])).toBeUndefined()

    const id = result.current.outbox[0]!.clientMessageId
    rerender({ fence: 3, submissions: [submission(id, 'pending')] })
    rerender({ fence: 3, submissions: [submission(id, 'accepted')] })
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    expect(result.current.error).toBeNull()
    expect(result.current.blockedClientMessageId).toBeNull()
  })
})

describe('a send the host refused by throwing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it("keeps the refusal on the message, with the refusal's words and not a bare failure", async () => {
    // As `mapRuntimeError` sends a thrown refusal (pinned in `rpc/errors.test.ts`).
    mocks.call.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'req-1',
        ok: false,
        error: {
          code: 'runtime_error',
          message: 'agent_session_journal_unreadable',
          data: {
            refusal: {
              code: 'agent_session_journal_unreadable',
              details: { reason: 'journalCorrupt' }
            }
          }
        }
      })
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

    await waitFor(() =>
      expect(result.current.outbox[0]?.lastFailure).toEqual({
        kind: 'refused',
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalCorrupt' }
      })
    )
    expect(shownFailure(result.current.outbox[0])).toBe(
      'Unable to load this chat. Your message was not sent.'
    )
  })
})

describe('a send refused on a journal a newer Orca wrote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('says to update Orca, not to try again', async () => {
    // As the host answers it (pinned in `journal-open-failure.test.ts`).
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: {
        code: 'agent_session_journal_unreadable',
        message: 'Chats were saved by a newer Orca. Update Orca to keep using them.',
        details: { reason: 'journalWrittenByNewerOrca' }
      }
    })
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: { kind: 'local' },
        fence: 1,
        submissions: []
      })
    )

    act(() => expect(result.current.send('hello')).toBe(true))

    await waitFor(() =>
      expect(shownFailure(result.current.outbox[0])).toBe(
        'Chats were saved by a newer Orca. Your message was not sent. Update Orca to keep using them.'
      )
    )
  })
})
