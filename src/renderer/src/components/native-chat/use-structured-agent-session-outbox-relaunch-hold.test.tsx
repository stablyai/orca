// @vitest-environment happy-dom

// A message the chat said was not sent, with a Retry beside it, waits for that Retry. The hold is
// read from the saved message, so quitting and reopening Orca (a new mount over the same storage)
// holds it exactly as the refusal did.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { AgentSessionWireRefusalCode } from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'

const SESSION = 'session-1'
// Stable, as the view passes it: a new object each render would re-run the owner-change requeue.
const LOCAL_TARGET = { kind: 'local' } as const
// Read back from storage, the cause may have cleared since (the user updated Orca, say).
const NOT_SENT_WORDS = 'Your message was not sent.'
const NEWER_ORCA_WORDS =
  'Chats were saved by a newer Orca. Your message was not sent. Update Orca to keep using them.'

type SendRequest = {
  body?: { blocks?: { text?: string }[] }
  envelope?: { clientOperationId?: string }
}

function requestId(params: SendRequest | undefined): string {
  return String(params?.envelope?.clientOperationId)
}

function sentIds(): string[] {
  return mocks.call.mock.calls.map((call) => requestId(call[2]))
}

function newerOrcaRefusal() {
  return {
    ok: false,
    refusal: {
      code: 'agent_session_journal_unreadable',
      message: 'Chats were saved by a newer Orca. Update Orca to keep using them.',
      details: { reason: 'journalWrittenByNewerOrca' }
    }
  }
}

function refusal(code: AgentSessionWireRefusalCode) {
  return { ok: false, refusal: { code, message: code } }
}

function accepted(clientMessageId: string) {
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

function hostAccepts(): void {
  mocks.call.mockImplementation((_target, _method, params: SendRequest) =>
    Promise.resolve(accepted(requestId(params)))
  )
}

function mount(fence = 1) {
  return renderHook(
    ({ fence: current }: { fence: number }) =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: LOCAL_TARGET,
        fence: current,
        submissions: []
      }),
    { initialProps: { fence } }
  )
}

type Outbox = ReturnType<typeof mount>['result']['current']

function notices(outbox: Outbox) {
  return structuredAgentSessionDeliveryNotices(
    outbox.outbox,
    'Claude',
    outbox.retry,
    [],
    [],
    outbox.failedHere
  )
}

function noticeFor(outbox: Outbox, clientMessageId: string) {
  return notices(outbox).get(agentJournalSubmissionKey(clientMessageId))
}

/** Long enough for any effect a mount or a state change schedules to have sent. */
async function settle(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
}

describe('a message the host refused, across a relaunch', () => {
  afterEach(() => {
    cleanup()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
  })

  it.each(['returned', 'thrown'] as const)(
    'is not sent on its own after a relaunch; its Retry sends it (refusal %s)',
    async (refusalDelivery) => {
      if (refusalDelivery === 'returned') {
        mocks.call.mockResolvedValueOnce(newerOrcaRefusal())
      } else {
        // As `mapRuntimeError` sends a thrown refusal (pinned in `rpc/errors.test.ts`).
        mocks.call.mockRejectedValueOnce(
          new RuntimeRpcCallError({
            id: 'req-1',
            ok: false,
            error: {
              code: 'runtime_error',
              message: 'agent_session_journal_unreadable',
              data: {
                refusal: {
                  code: 'agent_session_journal_unreadable',
                  details: { reason: 'journalWrittenByNewerOrca' }
                }
              }
            }
          })
        )
      }
      const before = mount()
      act(() => expect(before.result.current.send('hello')).toBe(true))
      await waitFor(() => expect(before.result.current.outbox[0]?.lastFailure).toBeDefined())
      const refusedId = sentIds()[0]!
      expect(noticeFor(before.result.current, refusedId)?.text).toBe(NEWER_ORCA_WORDS)
      before.unmount()

      // The user updates Orca and opens the chat again; the host now takes sends.
      hostAccepts()
      const after = mount()
      await settle()
      expect(mocks.call).toHaveBeenCalledTimes(1)
      const notice = noticeFor(after.result.current, refusedId)
      expect(notice?.text).toBe(NOT_SENT_WORDS)
      expect(notice?.onRetry).toBeDefined()

      act(() => notice?.onRetry?.())
      await waitFor(() => expect(after.result.current.outbox).toHaveLength(0))
      // The refusal recorded nothing, so the Retry goes out under the refused id.
      expect(sentIds()).toEqual([refusedId, refusedId])
    }
  )

  it('sends a message typed again after a refusal once, not a second time after a relaunch', async () => {
    // The chat's history is from a newer Orca: every send is refused until the user updates.
    mocks.call.mockResolvedValue(newerOrcaRefusal())
    const before = mount()
    act(() => expect(before.result.current.send('hello')).toBe(true))
    await waitFor(() => expect(before.result.current.outbox[0]?.lastFailure).toBeDefined())
    // The user types the same message again rather than pressing Retry.
    act(() => expect(before.result.current.send('hello')).toBe(true))
    await settle()
    const refusedBeforeUpdate = mocks.call.mock.calls.length
    before.unmount()

    hostAccepts()
    const after = mount()
    await settle()
    // Nothing goes out on its own: each message still says it was not sent, with its own Retry.
    expect(mocks.call).toHaveBeenCalledTimes(refusedBeforeUpdate)
    expect(after.result.current.outbox).toHaveLength(2)
    for (const entry of after.result.current.outbox) {
      expect(noticeFor(after.result.current, entry.clientMessageId)?.onRetry).toBeDefined()
    }

    // One Retry delivers the message once; the other copy stays unsent.
    act(() => after.result.current.retry(after.result.current.outbox[1]!.clientMessageId))
    await waitFor(() => expect(after.result.current.outbox).toHaveLength(1))
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(refusedBeforeUpdate + 1)
  })

  it('keeps a send that never reached the host held across a relaunch', async () => {
    mocks.call.mockRejectedValueOnce(new Error('send failed'))
    const before = mount()
    act(() => expect(before.result.current.send('hello')).toBe(true))
    await waitFor(() =>
      expect(before.result.current.outbox[0]?.lastFailure).toEqual({ kind: 'failed' })
    )
    const failedId = sentIds()[0]!
    before.unmount()

    hostAccepts()
    const after = mount()
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(noticeFor(after.result.current, failedId)?.onRetry).toBeDefined()
  })

  it('holds a refused message an earlier Orca saved, in the shape that build writes', async () => {
    // Exactly what a build from before this hold leaves behind after the refusal: no new field.
    localStorage.setItem(
      `orca:desktopStructuredAgentSessionOutbox:v1:${SESSION}`,
      JSON.stringify([
        {
          clientMessageId: 'op-refused',
          sessionId: SESSION,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
          previewUris: [],
          state: 'queued',
          queuedAt: 1,
          lastAttemptAt: 2,
          retryAfterUnknownSubmittedAt: null,
          lastFailure: {
            kind: 'refused',
            code: 'agent_session_journal_unreadable',
            details: { reason: 'journalWrittenByNewerOrca' }
          }
        }
      ])
    )
    hostAccepts()
    const { result } = mount()
    await settle()
    expect(mocks.call).not.toHaveBeenCalled()
    expect(noticeFor(result.current, 'op-refused')?.text).toBe(NOT_SENT_WORDS)
  })

  it("words the cause again once a Retry is refused for it; a relaunch's row only says not sent", async () => {
    mocks.call.mockResolvedValue(newerOrcaRefusal())
    const before = mount()
    act(() => expect(before.result.current.send('hello')).toBe(true))
    await waitFor(() => expect(before.result.current.outbox[0]?.lastFailure).toBeDefined())
    const refusedId = sentIds()[0]!
    before.unmount()

    // The chat's history is still from a newer Orca.
    const after = mount()
    await settle()
    expect(noticeFor(after.result.current, refusedId)).toMatchObject({ text: NOT_SENT_WORDS })

    act(() => noticeFor(after.result.current, refusedId)?.onRetry?.())
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(noticeFor(after.result.current, refusedId)?.text).toBe(NEWER_ORCA_WORDS)
    )
    expect(noticeFor(after.result.current, refusedId)?.onRetry).toBeDefined()
  })
})

// An older host restarts the agent inside a send and refuses it unrecorded when that fails. The
// refused message was shown as not sent, so neither a relaunch nor a new owner sends it.
describe('a message an older host refused, across a relaunch', () => {
  afterEach(() => {
    cleanup()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([])
  })

  it('is not sent on its own when the chat reopens on a moved fence', async () => {
    mocks.call.mockResolvedValueOnce(refusal('agent_session_checkpoint_stale'))
    const before = mount(1)
    act(() => expect(before.result.current.send('hello')).toBe(true))
    await waitFor(() => expect(before.result.current.outbox[0]?.lastFailure).toBeDefined())
    before.unmount()

    hostAccepts()
    mount(3)
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('is not sent when the fence moves while the chat is open; its Retry sends it once', async () => {
    hostAccepts()
    mocks.call.mockResolvedValueOnce(refusal('agent_session_checkpoint_stale'))
    const { result, rerender } = mount(1)
    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.lastFailure).toBeDefined())

    rerender({ fence: 3 })
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(1)

    act(() => result.current.retry(result.current.outbox[0]!.clientMessageId))
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    await settle()
    expect(sentIds()).toHaveLength(2)
    expect(sentIds()[1]).toBe(sentIds()[0])
  })
})

// A message left on its way out is in doubt after a relaunch, whatever an earlier attempt failed
// with: the unconfirmed probe resends it under its id rather than holding it for a Retry.
describe('a message in doubt that carries an earlier failure', () => {
  afterEach(() => {
    cleanup()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
  })

  it('is probed and sent again, not held', async () => {
    // What an earlier build left: on its way out, beside a failure it never cleared.
    const inDoubt = {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: 'op-in-doubt',
        sessionId: SESSION,
        text: 'hello',
        attachments: [],
        queuedAt: 1
      }),
      state: 'dispatching' as const,
      lastAttemptAt: 2,
      lastFailure: { kind: 'refused' as const, code: 'execution_owner_reconciling' as const }
    }
    writeOutbox(SESSION, [inDoubt])
    hostAccepts()
    const { result } = mount()
    await waitFor(() => expect(result.current.outbox).toHaveLength(0), { timeout: 5000 })
    expect(sentIds()).toEqual(['op-in-doubt'])
  })
})

describe('a message whose send could not be saved before it went out', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
  })

  it('waits for its Retry, and does not hold back the next message', async () => {
    hostAccepts()
    const save = localStorage.setItem.bind(localStorage)
    // The send saves; the save that marks it on its way out fails.
    const setItem = vi
      .spyOn(localStorage, 'setItem')
      .mockImplementationOnce(save)
      .mockImplementationOnce(() => {
        throw new Error('storage full')
      })
    const { result } = mount()
    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(result.current.error).toBe("Couldn't save your message. Try again."))
    setItem.mockRestore()
    const firstId = result.current.outbox[0]!.clientMessageId

    act(() => expect(result.current.send('second')).toBe(true))
    await waitFor(() => expect(result.current.outbox).toHaveLength(1))
    await settle()
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(sentIds()).not.toContain(firstId)
    expect(noticeFor(result.current, firstId)?.onRetry).toBeDefined()
  })

  function failingWrites(failing: readonly number[]): void {
    const save = localStorage.setItem.bind(localStorage)
    let writes = 0
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      writes += 1
      if (failing.includes(writes)) {
        throw new Error('storage full')
      }
      save(key, value)
    })
  }

  it('stays held when the message behind it goes out, though no save recorded the hold', async () => {
    hostAccepts()
    // Both messages save; the save marking the first on its way out, and the one recording its
    // hold, fail; storage then works again for the second.
    failingWrites([3, 4])
    const detached: { fence: number | null } = { fence: null }
    const { result, rerender } = renderHook(
      ({ fence }: { fence: number | null }) =>
        useStructuredAgentSessionOutbox({
          sessionId: SESSION,
          target: LOCAL_TARGET,
          fence,
          submissions: []
        }),
      { initialProps: detached }
    )
    act(() => expect(result.current.send('first')).toBe(true))
    act(() => expect(result.current.send('second')).toBe(true))
    const [firstId, secondId] = result.current.outbox.map((entry) => entry.clientMessageId)
    rerender({ fence: 1 })
    await waitFor(() => expect(result.current.outbox).toHaveLength(1))
    await settle()
    expect(sentIds()).toEqual([secondId])
    expect(result.current.outbox[0]).toMatchObject({
      clientMessageId: firstId,
      lastFailure: { kind: 'failed' }
    })
    expect(noticeFor(result.current, firstId!)?.onRetry).toBeDefined()
  })

  it('stays held across a relaunch once storage takes the hold', async () => {
    hostAccepts()
    // The send saves; the save marking it on its way out fails; the hold's own save goes through.
    failingWrites([2])
    const before = mount()
    act(() => expect(before.result.current.send('first')).toBe(true))
    await waitFor(() =>
      expect(before.result.current.error).toBe("Couldn't save your message. Try again.")
    )
    const firstId = before.result.current.outbox[0]!.clientMessageId
    before.unmount()
    vi.restoreAllMocks()

    const after = mount()
    await settle()
    expect(mocks.call).not.toHaveBeenCalled()
    expect(noticeFor(after.result.current, firstId)?.onRetry).toBeDefined()
  })
})

// A host forgets an operation id a day after it was made and refuses it for good after that. An
// earlier attempt under that id may already be in the chat, so the message stays a held row that
// says so; only the user's Retry sends it, under a new id.
describe('a held message whose id expired', () => {
  const DAY = 24 * 60 * 60 * 1000
  const EXPIRED_WORDS = "Orca couldn't confirm what happened. Check the chat."

  function expired() {
    return {
      ok: false,
      refusal: {
        code: 'agent_session_operation_expired',
        message: 'Operation expired.',
        details: { reason: 'operationExpired' }
      }
    }
  }

  afterEach(() => {
    cleanup()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearNativeChatDraftCacheForTests()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
  })

  it('stays a row that says it may be in the chat; its Retry sends it under a new id', async () => {
    mocks.call.mockResolvedValueOnce(newerOrcaRefusal()).mockResolvedValueOnce(expired())
    const before = mount()
    act(() => expect(before.result.current.send('hello')).toBe(true))
    await waitFor(() => expect(before.result.current.outbox[0]?.lastFailure).toBeDefined())
    const keptId = sentIds()[0]!
    act(() => before.result.current.retry(keptId))
    await waitFor(() =>
      expect(before.result.current.outbox[0]?.lastFailure).toMatchObject({
        code: 'agent_session_operation_expired'
      })
    )
    expect(before.result.current.error).toBeNull()
    before.unmount()

    hostAccepts()
    const after = mount()
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(2)
    const notice = noticeFor(after.result.current, keptId)
    expect(notice?.text).toBe(EXPIRED_WORDS)
    expect(notice?.onRetry).toBeDefined()

    act(() => notice?.onRetry?.())
    await waitFor(() => expect(after.result.current.outbox).toHaveLength(0))
    expect(sentIds()).toHaveLength(3)
    expect(sentIds()[2]).not.toBe(keptId)
  })

  it('stays in the chat, not the composer, when a relaunch resends it on its own', async () => {
    // Quit mid-send two days ago: the first message was on its way, the second queued behind it.
    const old = Date.now() - 2 * DAY
    const inFlight = {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: `${old}-${'1'.repeat(32)}`,
        sessionId: SESSION,
        text: 'first',
        attachments: [],
        queuedAt: old
      }),
      state: 'dispatching' as const,
      lastAttemptAt: old
    }
    writeOutbox(SESSION, [inFlight])
    mocks.call.mockResolvedValue(expired())
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: LOCAL_TARGET,
        fence: 1,
        submissions: [],
        composerScopeKey: 'pane-1'
      })
    )
    await waitFor(() => expect(mocks.call).toHaveBeenCalled(), { timeout: 5000 })
    await waitFor(() =>
      expect(result.current.outbox[0]?.lastFailure).toMatchObject({
        code: 'agent_session_operation_expired'
      })
    )
    await settle()
    expect(readNativeChatDraftCache('pane-1')).toBe('')
    expect(result.current.outbox).toMatchObject([
      { clientMessageId: inFlight.clientMessageId, state: 'queued' }
    ])
    expect(noticeFor(result.current, inFlight.clientMessageId)?.text).toBe(EXPIRED_WORDS)
    expect(sentIds()).toEqual([inFlight.clientMessageId])
  })
})
