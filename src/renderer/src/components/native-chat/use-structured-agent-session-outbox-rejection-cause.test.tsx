// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
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
import { advanceProbeClock, useProbeClock } from './NativeChatStructuredSession.test-harness'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { agentSessionWriteNoticeEnglish } from '../../../../shared/agent-session-refusal-notice'
import { structuredAgentSessionAttemptFailureParts } from '../../../../shared/structured-agent-session-send-disposition'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  hasUndeliveredStructuredAgentSessionOutbox,
  readOutbox,
  writeOutbox
} from './structured-agent-session-outbox-storage'

/** What these hooks render with: the journal's submissions, and the rows loaded so far. */
type OutboxProps = { submissions: AgentJournalSubmission[]; rows?: AgentJournalRenderItem[] }

function outboxProps(submissions: AgentJournalSubmission[]): OutboxProps {
  return { submissions }
}

const NO_JOURNAL_ITEMS: readonly AgentJournalRenderItem[] = []

// Why: every hook here shares the session outbox store; one left mounted would drain the next test's.
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

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

  it('names the cause on the message until the journal row takes it over', async () => {
    mocks.call.mockImplementationOnce(
      async (
        _target: unknown,
        _method: unknown,
        params: { envelope: { clientOperationId: string } }
      ) => rejectedResultFor(params.envelope.clientOperationId)
    )
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        journalItems: NO_JOURNAL_ITEMS,
        sessionId: 'session-1',
        target: { kind: 'local' },
        fence: 1,
        submissions: []
      })
    )

    act(() => expect(result.current.send('hello')).toBe(true))

    await waitFor(() => expect(shownFailure(result.current.outbox[0])).toBe(REASON))
    // Settled as not delivered: it holds no later message up.
    expect(result.current.error).toBeNull()
    expect(result.current.outbox[0]?.state).toBe('rejected')
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
        journalItems: NO_JOURNAL_ITEMS,
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

  it('leaves a message the host accepted and then could not deliver to its journal row', async () => {
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
      (props: OutboxProps) =>
        useStructuredAgentSessionOutbox({
          journalItems: props.rows ?? NO_JOURNAL_ITEMS,
          sessionId: 'session-1',
          target,
          fence: 1,
          submissions: props.submissions
        }),
      { initialProps: outboxProps(NO_SUBMISSIONS) }
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('dispatching'))
    const id = result.current.outbox[0]!.clientMessageId

    rerender({
      submissions: [
        { ...pendingResultFor(id).value.submission, dispatchState: 'rejected', reason }
      ],
      rows: rowsFor(id)
    })

    // The host's row shows it as not sent, with no Retry: nothing resends it.
    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(result.current.error).toBeNull()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(mocks.call).toHaveBeenCalledOnce()
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
      (props: OutboxProps) =>
        useStructuredAgentSessionOutbox({
          journalItems: props.rows ?? NO_JOURNAL_ITEMS,
          sessionId: 'session-1',
          target,
          fence: 1,
          submissions: props.submissions
        }),
      { initialProps: outboxProps(NO_SUBMISSIONS) }
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

  it('leaves a message rejected while the chat was closed to its journal row, and sends past it', async () => {
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
        journalItems: NO_JOURNAL_ITEMS,
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
    const reopenedRows = rowsFor(id)
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        journalItems: reopenedRows,
        sessionId: 'session-1',
        target,
        fence: 1,
        submissions: rejected
      })
    )

    await waitFor(() => expect(result.current.outbox).toEqual([]))
    act(() => expect(result.current.send('second')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
  })

  // One stored host fact, one rendering: a message the host recorded and rejected, whose record this
  // chat does not hold, keeps showing why on every mount, with no control, and is never sent again.
  it('keeps a message the host rejected, with no control, on every mount, and never resends it', async () => {
    useProbeClock()
    writeOutbox('session-1', [
      {
        ...rejectedBeforeRestart(),
        state: 'dispatching',
        lastFailure: undefined,
        lastAttemptAt: 5
      }
    ])
    // The host replays its rejection when the reopened chat asks about the send it left in doubt.
    mocks.call.mockImplementation(async (_target, _method, params) =>
      rejectedResultFor(String(params.envelope.clientOperationId))
    )
    const notice = (
      outbox: readonly StructuredAgentSessionOutboxEntry[],
      failedHere: ReadonlySet<string>
    ) =>
      structuredAgentSessionDeliveryNotices(
        outbox,
        'Claude',
        () => {},
        NO_SUBMISSIONS,
        [],
        failedHere
      ).get(agentJournalSubmissionKey('rejected-before-restart'))
    const mount = () =>
      renderHook(() =>
        useStructuredAgentSessionOutbox({
          journalItems: NO_JOURNAL_ITEMS,
          sessionId: 'session-1',
          target: { kind: 'local' },
          fence: 1,
          submissions: NO_SUBMISSIONS
        })
      )

    const first = mount()
    await advanceProbeClock(1000)
    expect(first.result.current.outbox[0]?.state).toBe('rejected')
    const onFirst = notice(first.result.current.outbox, first.result.current.failedHere)
    first.unmount()
    const second = mount()
    const onSecond = notice(second.result.current.outbox, second.result.current.failedHere)

    for (const shown of [onFirst, onSecond]) {
      expect(shown).toEqual({ text: REASON })
    }
    await advanceProbeClock(1500)
    // Only the first mount's question about the send it left in doubt; nothing resends it.
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(second.result.current.outbox.map((entry) => entry.state)).toEqual(['rejected'])
    expect(readOutbox('session-1')).toHaveLength(1)
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-1')).toBe(false)
  }, 10000)

  // The host's own record is what lets it go, and storage forgets it too: nothing is owed.
  it('drops a message rejected before a restart once the journal says so, from storage too', async () => {
    writeOutbox('session-1', [rejectedBeforeRestart()])
    const { result, rerender } = renderHook(
      (props: OutboxProps) =>
        useStructuredAgentSessionOutbox({
          journalItems: props.rows ?? NO_JOURNAL_ITEMS,
          sessionId: 'session-1',
          target: { kind: 'local' },
          fence: 1,
          submissions: props.submissions
        }),
      { initialProps: outboxProps(NO_SUBMISSIONS) }
    )
    expect(result.current.outbox).toHaveLength(1)

    rerender({
      submissions: [
        {
          ...pendingResultFor('rejected-before-restart').value.submission,
          dispatchState: 'rejected',
          reason: 'The provider did not accept this message.',
          resolvedAt: 2
        }
      ],
      rows: rowsFor('rejected-before-restart')
    })

    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(readOutbox('session-1')).toEqual([])
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-1')).toBe(false)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  // An older host leaves a rejected message where it was sent, which may be outside the loaded
  // window: the entry draws it, with no control, until the row that draws it loads.
  it('keeps a rejected message whose row is not loaded, then lets it go once the row loads', async () => {
    writeOutbox('session-1', [
      { ...rejectedBeforeRestart(), state: 'dispatching', lastFailure: undefined, lastAttemptAt: 5 }
    ])
    const rejected = [
      {
        ...pendingResultFor('rejected-before-restart').value.submission,
        dispatchState: 'rejected' as const,
        reason: REASON,
        resolvedAt: 2
      }
    ]
    const { result, rerender } = renderHook(
      (props: OutboxProps) =>
        useStructuredAgentSessionOutbox({
          journalItems: props.rows ?? NO_JOURNAL_ITEMS,
          sessionId: 'session-1',
          target: { kind: 'local' },
          fence: 1,
          submissions: props.submissions
        }),
      { initialProps: outboxProps(rejected) }
    )

    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('rejected'))
    expect(shownFailure(result.current.outbox[0])).toBe(REASON)
    expect(readOutbox('session-1')).toHaveLength(1)

    rerender({ submissions: rejected, rows: rowsFor('rejected-before-restart') })
    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(readOutbox('session-1')).toEqual([])
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('keeps a send its reply rejected without a Retry until the journal row takes it over', async () => {
    const writeFailed = (clientMessageId: string): AgentJournalSubmission => ({
      clientMessageId,
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState: 'rejected',
      providerItemId: null,
      reason: 'provider_write_failed: broken pipe',
      submittedAt: 10,
      resolvedAt: 10
    })
    mocks.call.mockImplementationOnce(
      async (
        _target: unknown,
        _method: unknown,
        params: { envelope: { clientOperationId: string } }
      ) => ({
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'epoch-1', sequence: 10 },
        value: {
          clientMessageId: params.envelope.clientOperationId,
          submission: writeFailed(params.envelope.clientOperationId)
        }
      })
    )
    const { result, rerender } = renderHook(
      (props: OutboxProps) =>
        useStructuredAgentSessionOutbox({
          journalItems: props.rows ?? NO_JOURNAL_ITEMS,
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions: props.submissions
        }),
      { initialProps: outboxProps(NO_SUBMISSIONS) }
    )

    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const firstId = String(mocks.call.mock.calls[0]![2].envelope.clientOperationId)

    // Answered, not doubted: the entry draws the message, saying why, until the journal has it.
    await waitFor(() => expect(result.current.outbox[0]?.lastFailure?.kind).toBe('rejected'))
    expect(result.current.outbox[0]?.state).toBe('rejected')

    rerender({ submissions: [writeFailed(firstId)], rows: rowsFor(firstId) })
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('lets the journal settle the message when its rejection lands before the send answers', async () => {
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
      (props: OutboxProps) =>
        useStructuredAgentSessionOutbox({
          journalItems: props.rows ?? NO_JOURNAL_ITEMS,
          sessionId: 'session-1',
          target,
          fence: 1,
          submissions: props.submissions
        }),
      { initialProps: outboxProps(NO_SUBMISSIONS) }
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('dispatching'))
    const id = result.current.outbox[0]!.clientMessageId

    // A start refused at once: the rejection frame lands before the send's own `pending` answer.
    rerender({
      submissions: [
        { ...pendingResultFor(id).value.submission, dispatchState: 'rejected', reason }
      ],
      rows: rowsFor(id)
    })
    await waitFor(() => expect(result.current.outbox).toEqual([]))
    // The late `pending` answer must not bring it back.
    await act(async () => answer(pendingResultFor(id)))

    expect(result.current.outbox).toEqual([])
    expect(result.current.error).toBeNull()
  })
})

const NO_SUBMISSIONS: AgentJournalSubmission[] = []

/** The host's rows for these messages, loaded. */
function rowsFor(...ids: string[]): AgentJournalRenderItem[] {
  return ids.map((id, index) => ({
    itemId: agentJournalSubmissionKey(id),
    revision: 1,
    sequence: index + 1,
    observedAt: index + 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] }
  }))
}

function rejectedBeforeRestart(): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'rejected-before-restart',
      sessionId: 'session-1',
      text: 'first',
      attachments: [],
      queuedAt: 1
    }),
    state: 'rejected',
    lastFailure: {
      kind: 'rejected',
      reason: 'The provider did not accept this message.',
      rejection: { kind: 'providerRejected' }
    }
  }
}

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

// An older host restarts the agent inside the send. A send it refused was shown as not sent, so it
// waits for the user's Retry even once the agent has a new owner, as on every host.
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
  it('waits for its Retry across an agent restart, and leaves no error once that Retry lands', async () => {
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
          journalItems: NO_JOURNAL_ITEMS,
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

    // The pane learns the new owner; the message still waits for its Retry.
    rerender({ fence: 3, submissions: [] })
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(shownFailure(result.current.outbox[0])).toBe('Your message was not sent.')

    act(() => result.current.retry(result.current.outbox[0]!.clientMessageId))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(result.current.outbox[0]).toMatchObject({ state: 'dispatching' })
    expect(shownFailure(result.current.outbox[0])).toBeUndefined()

    const id = result.current.outbox[0]!.clientMessageId
    rerender({ fence: 3, submissions: [submission(id, 'pending')] })
    rerender({ fence: 3, submissions: [submission(id, 'accepted')] })
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    expect(result.current.error).toBeNull()
    expect(mocks.call).toHaveBeenCalledTimes(2)
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
        journalItems: NO_JOURNAL_ITEMS,
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
        journalItems: NO_JOURNAL_ITEMS,
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
