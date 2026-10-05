// A message a Stop withdrew never ran, and nothing sends it again. Its sender gets the text and
// images back in the composer, once, after whatever is typed there.

// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_WRITE_FAILED
} from '../../../../shared/structured-agent-session-dispatch-rejection'

type SendParams = { envelope?: { clientOperationId: string } }
type ReadState = { submissions: AgentJournalSubmission[]; items: AgentJournalRenderItem[] }

const mocks = vi.hoisted(() => {
  const read: ReadState = { submissions: [], items: [] }
  return {
    call: vi.fn<(target: unknown, method: string, params: SendParams) => Promise<unknown>>(),
    toastError: vi.fn(),
    read
  }
})

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false)
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 1,
      items: mocks.read.items,
      submissions: mocks.read.submissions,
      status: 'ready',
      error: null,
      hasOlder: false
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import {
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  appendNativeChatDraftCache,
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  subscribeToNativeChatDraftAppend,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import {
  appendNativeChatAttachmentCache,
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'
import { useNativeChatDraft } from './use-native-chat-draft'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  readOutbox,
  writeOutbox
} from './structured-agent-session-outbox-storage'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { useStructuredAgentSession } from './use-structured-agent-session'

/** What these hooks render with: the journal's submissions, and the rows loaded so far. */
type OutboxProps = { submissions: AgentJournalSubmission[]; rows?: AgentJournalRenderItem[] }

function outboxProps(submissions: AgentJournalSubmission[]): OutboxProps {
  return { submissions }
}

const NO_JOURNAL_ITEMS: readonly AgentJournalRenderItem[] = []

const SESSION = 'session-1'
const PANE = 'tab-1::session-1'
const OTHER_PANE = 'tab-2::session-1'
const target = { kind: 'local' } as const
const NONE: AgentJournalSubmission[] = []

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 10,
    resolvedAt: null,
    handoverRecorded: true,
    ...overrides
  }
}

function withdrawn(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return submission(clientMessageId, {
    dispatchState: 'rejected',
    reason: DISPATCH_REJECTED_CANCELLED,
    resolvedAt: 11,
    ...overrides
  })
}

function answerSendsPending(): void {
  mocks.call.mockImplementation(async (_target, method, params) => {
    if (method !== 'agentSession.send') {
      return null
    }
    const id = params.envelope?.clientOperationId ?? ''
    return {
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 2 },
      value: { clientMessageId: id, submission: submission(id) }
    }
  })
}

function renderOutbox(composerScopeKey: string | null = PANE) {
  return renderHook(
    (props: OutboxProps) =>
      useStructuredAgentSessionOutbox({
        journalItems: props.rows ?? NO_JOURNAL_ITEMS,
        sessionId: SESSION,
        target,
        fence: 1,
        submissions: props.submissions,
        ...(composerScopeKey ? { composerScopeKey } : {})
      }),
    { initialProps: outboxProps(NONE) }
  )
}

async function sendToHost(
  result: { current: ReturnType<typeof useStructuredAgentSessionOutbox> },
  text: string,
  attachments: { path: string; previewUri: string }[] = []
): Promise<string> {
  act(() => expect(result.current.send(text, attachments)).toBe(true))
  await waitFor(() => expect(result.current.outbox.at(-1)?.state).toBe('dispatching'))
  return result.current.outbox.at(-1)!.clientMessageId
}

function occurrences(text: string, of: string): number {
  return text.split(of).length - 1
}

afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  clearNativeChatAttachmentCacheForTests()
  mocks.read.submissions = []
  mocks.read.items = []
  let uuid = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    uuid += 1
    return `11111111-1111-4111-8111-${uuid.toString(16).padStart(12, '0')}`
  })
})

describe('a message the host withdrew at a Stop', () => {
  it.each([
    ['a Stop during the start withdrew it from the host queue', {}],
    ['Claude cancelled it as a queued follow-up', { handedOverAt: 12 }]
  ])(
    'comes back to the composer with its images, after the draft, when %s',
    async (_case, handover) => {
      answerSendsPending()
      writeNativeChatDraftCache(PANE, 'already typed')
      appendNativeChatAttachmentCache(PANE, [{ id: 'typed', path: '/tmp/typed.png' }])
      const { result, rerender } = renderOutbox()
      const id = await sendToHost(result, 'hello', [
        { path: '/tmp/shot.png', previewUri: '/tmp/shot.png' }
      ])
      rerender({ submissions: [submission(id, handover)] })

      rerender({ submissions: [withdrawn(id, handover)] })

      await waitFor(() => expect(result.current.outbox).toEqual([]))
      expect(readNativeChatDraftCache(PANE)).toBe('already typed\n\nhello')
      expect(readNativeChatAttachmentCache(PANE)).toEqual([
        { id: 'typed', path: '/tmp/typed.png' },
        { id: expect.any(String), path: '/tmp/shot.png' }
      ])
    }
  )

  it('comes back when the host wrote the withdrawal as a typed fact in a sentence', async () => {
    answerSendsPending()
    const { result, rerender } = renderOutbox()
    const id = await sendToHost(result, 'hello')

    rerender({
      submissions: [
        withdrawn(id, {
          reason: 'This message was withdrawn before the agent started it.',
          rejection: { kind: 'cancelled' }
        })
      ]
    })

    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(readNativeChatDraftCache(PANE)).toBe('hello')
  })

  it('comes back once, whatever replays the journal or shows the chat again', async () => {
    answerSendsPending()
    const first = renderOutbox()
    const id = await sendToHost(first.result, 'hello')
    // A second view of the same chat in this window reads the same outbox.
    const second = renderOutbox(OTHER_PANE)

    first.rerender({ submissions: [withdrawn(id)] })
    second.rerender({ submissions: [withdrawn(id)] })
    // A replayed snapshot, then a reconnect remounting the view.
    first.rerender({ submissions: [{ ...withdrawn(id) }] })
    first.unmount()
    renderOutbox().rerender({ submissions: [withdrawn(id)] })

    await waitFor(() => expect(readOutbox(SESSION)).toEqual([]))
    const restored = readNativeChatDraftCache(PANE) + readNativeChatDraftCache(OTHER_PANE)
    expect(occurrences(restored, 'hello')).toBe(1)
  })

  it('is back in the composer before it leaves storage, so a crash between repeats it', async () => {
    answerSendsPending()
    const { result, rerender } = renderOutbox()
    const id = await sendToHost(result, 'hello')
    let storedAtRestore: string[] = []
    const unsubscribe = subscribeToNativeChatDraftAppend(PANE, () => {
      storedAtRestore = readOutbox(SESSION).map((entry) => entry.clientMessageId)
    })
    const beforeDrop = readOutbox(SESSION, { recoverDispatching: false })

    rerender({ submissions: [withdrawn(id)] })
    unsubscribe()

    expect(storedAtRestore).toEqual([id])
    // The drop never reached storage: after a crash, which loses the in-memory draft, the next mount
    // gives the text back again rather than losing it.
    cleanup()
    writeNativeChatDraftCache(PANE, '')
    writeOutbox(SESSION, beforeDrop)
    renderOutbox().rerender({ submissions: [withdrawn(id)] })
    expect(readNativeChatDraftCache(PANE)).toBe('hello')
  })

  it("leaves a message rejected for any other reason to the host's row, and gives nothing back", async () => {
    answerSendsPending()
    const { result, rerender } = renderOutbox()
    const id = await sendToHost(result, 'hello')

    rerender({
      submissions: [
        submission(id, { dispatchState: 'rejected', reason: DISPATCH_REJECTED_WRITE_FAILED })
      ],
      rows: [
        {
          itemId: `orca:${id}`,
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
        }
      ]
    })

    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(readNativeChatDraftCache(PANE)).toBe('')
  })

  it('drops a withdrawn launch prompt where no composer shows the chat', () => {
    const launch = enqueueStructuredAgentSessionLaunchPrompt(SESSION, 'launch text')!
    const { result, rerender } = renderOutbox(null)

    expect(() => rerender({ submissions: [withdrawn(launch.clientMessageId)] })).not.toThrow()

    expect(result.current.outbox).toEqual([])
    expect(readOutbox(SESSION)).toEqual([])
    expect(readNativeChatDraftCache(PANE)).toBe('')
  })
})

describe('a message a Stop took out of the outbox before the host held it', () => {
  it('comes back to the composer when the Stop follows the send at once', async () => {
    mocks.call.mockImplementation(() => new Promise<never>(() => {}))
    const { result } = renderOutbox()
    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    act(() => expect(result.current.send('second')).toBe(true))

    act(() => result.current.withdrawUnsent())

    expect(result.current.outbox.map((entry) => entry.body.blocks)).toEqual([
      [{ type: 'text', text: 'first' }]
    ])
    expect(readNativeChatDraftCache(PANE)).toBe('second')
  })

  it('gives back a send already on its way only when the host withdraws it', async () => {
    answerSendsPending()
    const reply = Promise.withResolvers<void>()
    const answer = mocks.call.getMockImplementation()!
    mocks.call.mockImplementationOnce(async (...args) => {
      await reply.promise
      return answer(...args)
    })
    const { result, rerender } = renderOutbox()
    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    const id = result.current.outbox[0]!.clientMessageId

    act(() => result.current.withdrawUnsent())
    // It lands ahead of the Stop and reads as sent, not as back in the composer.
    await act(async () => reply.resolve())
    rerender({ submissions: [submission(id)] })
    expect(readNativeChatDraftCache(PANE)).toBe('')
    expect(result.current.outbox.map((entry) => entry.clientMessageId)).toEqual([id])

    rerender({ submissions: [withdrawn(id)] })

    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(readNativeChatDraftCache(PANE)).toBe('hello')
  })

  it('leaves a message waiting on Retry where it is, and gives back only what it withdrew', async () => {
    writeOutbox(SESSION, [
      {
        clientMessageId: 'refused-1',
        sessionId: SESSION,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'refused' }] },
        previewUris: [],
        state: 'rejected',
        queuedAt: 1,
        lastAttemptAt: null,
        retryAfterUnknownSubmittedAt: null
      }
    ])
    mocks.call.mockImplementation(() => new Promise<never>(() => {}))
    const { result } = renderOutbox()
    act(() => expect(result.current.send('second')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    act(() => expect(result.current.send('third')).toBe(true))
    const onItsWay = result.current.outbox[1]!.clientMessageId

    act(() => result.current.withdrawUnsent())

    expect(result.current.outbox.map((entry) => entry.clientMessageId)).toEqual([
      'refused-1',
      onItsWay
    ])
    expect(readNativeChatDraftCache(PANE)).toBe('third')
  })
})

describe('Stop through the chat', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY
    ])
    writeOutbox(SESSION, [
      {
        clientMessageId: 'queued-1',
        sessionId: SESSION,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
        previewUris: [],
        state: 'dispatching',
        queuedAt: 1,
        lastAttemptAt: 1,
        retryAfterUnknownSubmittedAt: null
      }
    ])
    mocks.read.submissions = [submission('queued-1')]
  })

  function renderChat() {
    return renderHook(() =>
      useStructuredAgentSession({
        sessionId: SESSION,
        agent: 'claude',
        target,
        isVisible: true,
        composerScopeKey: PANE
      })
    )
  }

  it('gives back what the host withdrew into the pane that pressed it', async () => {
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.cancel' ? { ok: true, value: { cancelled: true } } : null
    )
    const { result, rerender } = renderChat()

    await act(async () => {
      await result.current.stop()
    })
    mocks.read.submissions = [withdrawn('queued-1')]
    rerender()

    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(readNativeChatDraftCache(PANE)).toBe('hello')
  })

  it('says a failed Stop in a toast and gives nothing back', async () => {
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.cancel'
        ? { ok: false, refusal: { code: 'agent_session_not_found', message: 'Gone.' } }
        : null
    )
    const { result, rerender } = renderChat()

    await act(async () => {
      await result.current.stop()
    })
    rerender()

    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(readNativeChatDraftCache(PANE)).toBe('')
    expect(result.current.outbox.map((entry) => entry.clientMessageId)).toEqual(['queued-1'])
  })
})

const notComposing = (): boolean => false

describe('an open composer', () => {
  it('shows text put back while it is open, after what is typed', () => {
    const { result } = renderHook(() => useNativeChatDraft(PANE, notComposing))
    act(() => result.current.setDraft('typed'))

    act(() => appendNativeChatDraftCache(PANE, 'hello'))

    expect(result.current.draft).toBe('typed\n\nhello')
  })

  it('keeps text put back mid-composition through the composed writes, even if it unmounts', () => {
    const { result, unmount } = renderHook(() => useNativeChatDraft(PANE, () => true))
    act(() => appendNativeChatDraftCache(PANE, 'hello'))
    act(() => result.current.setDraft('typed'))

    expect(result.current.draft).toBe('typed')
    unmount()
    expect(readNativeChatDraftCache(PANE)).toBe('typed\n\nhello')
  })

  it('shows images put back while it is open, beside the ones attached', () => {
    const { result } = renderHook(() =>
      useNativeChatComposerAttachments({
        attachmentScopeKey: PANE,
        allowWithoutTarget: true,
        caret: 0,
        disabled: false,
        isComposing: () => false,
        resolveTarget: () => null,
        textareaRef: { current: null },
        setCaret: () => {},
        setDraft: () => {},
        setNotice: () => {}
      })
    )
    act(() => result.current.attachResolvedPaths(['/tmp/typed.png']))

    act(() => appendNativeChatAttachmentCache(PANE, [{ id: 'restored', path: '/tmp/shot.png' }]))

    expect(result.current.imageAttachments.map((attachment) => attachment.path)).toEqual([
      '/tmp/typed.png',
      '/tmp/shot.png'
    ])
  })
})
