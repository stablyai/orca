// @vitest-environment happy-dom
// Opening a chat an older build left stuck: the host recorded its first message in doubt and later
// recovered it, while the older build's saved copy still held that message plus two queued behind
// it. Real chat hook, sends, legacy recovery and draft store; only the history read and RPC are faked.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  outline: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

let fence: number | null = 10
let items: AgentJournalRenderItem[] = []
let submissions: AgentJournalSubmission[] = []

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  readStructuredAgentSessionConversationOutline: mocks.outline,
  supportsStructuredAgentSessionQuietRepeatedStop: vi.fn(async () => false),
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false),
  supportsStructuredAgentSessionQuestionAnswers: vi.fn(async () => false)
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence,
      commands: undefined,
      items,
      submissions,
      status: 'ready',
      error: null,
      hasOlder: false,
      handoff: null
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { useStructuredAgentSession } from './use-structured-agent-session'
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'

const SESSION = 'session-1'
const KEY = `orca:desktopStructuredAgentSessionOutbox:v1:${SESSION}`
const IN_DOUBT = '1000-in-doubt'
const SECOND = '2000-second'
const THIRD = '3000-third'

function saved(clientMessageId: string, text: string, state: string, lastAttemptAt: number | null) {
  return {
    clientMessageId,
    sessionId: SESSION,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    previewUris: [],
    state,
    queuedAt: Number(clientMessageId.split('-')[0]),
    lastAttemptAt,
    retryAfterUnknownSubmittedAt: null
  }
}

function outline(ids: string[], omittedEntries = 0) {
  return {
    sessionId: SESSION,
    cursor: { epoch: 'e', sequence: 50 },
    entries: ids.map((id, index) => ({
      itemId: agentJournalSubmissionKey(id),
      sequence: 40 + index,
      preview: '',
      imageCount: 0
    })),
    omittedEntries
  }
}

/** The host's row for the first message: in doubt when its provider closed, then recovered. */
const IN_DOUBT_SUBMISSION: AgentJournalSubmission = {
  clientMessageId: IN_DOUBT,
  fence: 9,
  payloadFingerprint: 'fp-1',
  dispatchState: 'unknown',
  providerItemId: null,
  reason: 'provider_closed_before_acknowledgement',
  submittedAt: 1_100,
  resolvedAt: 1_200,
  recovered: true
}

const IN_DOUBT_ITEM: AgentJournalRenderItem = {
  itemId: agentJournalSubmissionKey(IN_DOUBT),
  revision: 1,
  sequence: 49,
  observedAt: 1_100,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'first' }] }
}

const draft = () => readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(SESSION)).text
const sendCalls = () => mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')

function renderChat() {
  return renderHook(() =>
    useStructuredAgentSession({
      sessionId: SESSION,
      target: { kind: 'local' },
      agent: 'claude',
      isVisible: true
    })
  )
}

describe('opening a chat an older build left stuck behind a message in doubt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentSessionSendsForTests()
    clearNativeChatDraftCacheForTests()
    fence = 10
    items = [IN_DOUBT_ITEM]
    submissions = [IN_DOUBT_SUBMISSION]
    mocks.call.mockResolvedValue(null)
    localStorage.setItem(
      KEY,
      JSON.stringify([
        saved(IN_DOUBT, 'first', 'unconfirmed', 1_050),
        saved(SECOND, 'second', 'queued', null),
        saved(THIRD, 'third', 'queued', null)
      ])
    )
  })
  afterEach(cleanup)

  it('gives the two queued messages back once, in order, and leaves the chat free to send', async () => {
    mocks.outline.mockResolvedValue(outline([IN_DOUBT]))
    const { result } = renderChat()

    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
    expect(draft()).toBe('second\n\nthird')
    expect(result.current.error).toBe('Your message was not sent. Send it again.')
    // The first is the host's own row, drawn plain.
    const row = result.current.messages.find(
      (message) => message.id === agentJournalSubmissionKey(IN_DOUBT)
    )
    expect(row).toBeDefined()
    expect(row && 'unsent' in row ? row.unsent : undefined).toBeUndefined()
    expect(result.current.messages.map((message) => message.id)).not.toContain(
      agentJournalSubmissionKey(SECOND)
    )
    expect(result.current.isWorking).toBe(false)
    expect(result.current.canStop).toBe(false)
    expect(result.current.sendOut).toBe(false)
    expect(result.current.pending).toEqual([])
    expect(sendCalls()).toEqual([])
  })

  it("says it couldn't confirm when the host can't list the whole conversation", async () => {
    mocks.outline.mockResolvedValue(null)
    const { result } = renderChat()

    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
    expect(result.current.error).toContain("couldn't confirm your message reached the agent")
  })

  it("sends the next message under the fence the chat's read reported", async () => {
    mocks.outline.mockResolvedValue(outline([IN_DOUBT]))
    const { result } = renderChat()
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
    mocks.call.mockImplementation(async (_target: unknown, method: string) =>
      method === 'agentSession.send'
        ? {
            ok: true,
            replayed: false,
            value: {
              clientMessageId: 'next',
              submission: {
                ...IN_DOUBT_SUBMISSION,
                clientMessageId: 'next',
                fence: 11,
                dispatchState: 'pending',
                recovered: undefined,
                reason: null
              }
            }
          }
        : null
    )

    let sent: unknown
    act(() => {
      sent = result.current.send('next')
    })

    expect(sent).toBe(true)
    await waitFor(() => expect(sendCalls()).toHaveLength(1))
    expect(sendCalls()[0]?.[2].envelope.expectedRuntimeFence).toBe(10)
    // The read's fence is used, with no history read for it.
    expect(mocks.call.mock.calls.some(([, method]) => method === 'agentSession.history')).toBe(
      false
    )
  })

  it('leaves the copy alone while the chat has no fence on this host', async () => {
    fence = null
    mocks.outline.mockResolvedValue(outline([IN_DOUBT]))
    renderChat()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.outline).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY)).not.toBeNull()
  })
})
