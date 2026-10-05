// A structured card answer is an outbox entry with a card origin. Where it stands is read from
// the persisted outbox every render, so a remount or relaunch can't re-enable Send for an answer
// still on its way, and every way it fails to land gives its answers back to the card.

// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatAsyncQuestionsView } from '../../../../shared/native-chat-async-questions'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_WRITE_FAILED
} from '../../../../shared/structured-agent-session-dispatch-rejection'

type SendParams = { envelope?: { clientOperationId: string } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SendParams) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false)
}))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { clearNativeChatAsyncQuestionCardStoreForTests } from './native-chat-async-question-card-store'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { useStructuredNativeChatAsyncQuestions } from './use-structured-native-chat-async-questions'

const SESSION = 'session-async'
const PANE = 'tab-1::session-async'
const target = { kind: 'local' } as const
const VIEW: NativeChatAsyncQuestionsView = {
  state: 'ready',
  questions: [{ key: 'a', index: 0, title: 'A?', options: ['yes', 'no'] }]
}

type Props = {
  submissions: AgentJournalSubmission[]
  fence: number | null
  rows?: AgentJournalRenderItem[]
}

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
    ...overrides
  }
}

function render(initial: Props) {
  return renderHook(
    (props: Props) => {
      const outbox = useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target,
        fence: props.fence,
        submissions: props.submissions,
        journalItems: props.rows ?? [],
        composerScopeKey: PANE
      })
      const card = useStructuredNativeChatAsyncQuestions(PANE, {
        sendAsyncAnswer: outbox.sendAsyncAnswer,
        outbox: outbox.outbox,
        asyncQuestions: VIEW
      })
      return { outbox, card }
    },
    { initialProps: initial }
  )
}

type Rendered = ReturnType<typeof render>['result']

function answerYes(result: Rendered): string {
  act(() => result.current.card.edit('a', { option: 'yes' }))
  act(() => result.current.card.submit())
  return result.current.outbox.outbox.at(-1)!.clientMessageId
}

function hangSends(): void {
  mocks.call.mockImplementation(() => new Promise(() => {}))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  clearNativeChatAsyncQuestionCardStoreForTests()
  let uuid = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    uuid += 1
    return `22222222-2222-4222-8222-${uuid.toString(16).padStart(12, '0')}`
  })
})

afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
})

describe('structured async answers', () => {
  it('holds the answer in the outbox: the card shows it, Send waits, the draft is untouched', async () => {
    hangSends()
    writeNativeChatDraftCache(PANE, 'half-typed')
    const { result } = render({ submissions: [], fence: null })
    answerYes(result)
    expect(result.current.outbox.outbox[0]).toMatchObject({
      origin: { kind: 'async-answer', edits: { a: 'yes' } }
    })
    await waitFor(() => expect(result.current.card.sending).toBe(true))
    expect(result.current.card.edits).toEqual({ a: { option: 'yes' } })
    expect(result.current.card.canSend).toBe(false)
    expect(readNativeChatDraftCache(PANE)).toBe('half-typed')
  })

  it('keeps Send disabled across a remount and a relaunch while the entry is on its way', async () => {
    hangSends()
    const first = render({ submissions: [], fence: null })
    answerYes(first.result)
    first.unmount()
    // A relaunch: the card store is gone, the persisted outbox is not.
    clearNativeChatAsyncQuestionCardStoreForTests()
    const again = render({ submissions: [], fence: null })
    expect([...again.result.current.card.held]).toEqual(['a'])
    expect(again.result.current.card.canSend).toBe(false)
    act(() => again.result.current.card.submit())
    expect(again.result.current.outbox.outbox).toHaveLength(1)
  })

  it('gives the answers back to the card on a Stop before dispatch, not to the composer', async () => {
    hangSends()
    writeNativeChatDraftCache(PANE, 'half-typed')
    const { result, rerender, unmount } = render({ submissions: [], fence: null })
    answerYes(result)
    act(() => result.current.outbox.withdrawUnsent())
    rerender({ submissions: [], fence: null })
    await waitFor(() => expect(result.current.outbox.outbox).toHaveLength(0))
    expect(result.current.card.sending).toBe(false)
    expect(result.current.card.edits).toEqual({ a: { option: 'yes' } })
    expect(result.current.card.canSend).toBe(true)
    expect(readNativeChatDraftCache(PANE)).toBe('half-typed')
    // The card's store keeps them across a terminal/chat toggle.
    unmount()
    const again = render({ submissions: [], fence: null })
    expect(again.result.current.card.edits).toEqual({ a: { option: 'yes' } })
  })

  it('gives the answers back when the host withdrew it, without restoring it to the composer', async () => {
    hangSends()
    writeNativeChatDraftCache(PANE, 'half-typed')
    const { result, rerender } = render({ submissions: [], fence: null })
    const id = answerYes(result)
    rerender({
      fence: 1,
      submissions: [
        submission(id, { dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED })
      ]
    })
    await waitFor(() => expect(result.current.outbox.outbox).toHaveLength(0))
    expect(result.current.card.edits).toEqual({ a: { option: 'yes' } })
    expect(result.current.card.canSend).toBe(true)
    expect(readNativeChatDraftCache(PANE)).toBe('half-typed')
  })

  it('gives the answers back when the host refused it and its row has loaded', async () => {
    hangSends()
    const { result, rerender } = render({ submissions: [], fence: null })
    const id = answerYes(result)
    rerender({
      fence: 1,
      submissions: [
        submission(id, { dispatchState: 'rejected', reason: DISPATCH_REJECTED_WRITE_FAILED })
      ],
      rows: [
        {
          itemId: `orca:${id}`,
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'A?' }] }
        }
      ]
    })
    await waitFor(() => expect(result.current.outbox.outbox).toHaveLength(0))
    expect(result.current.card.edits).toEqual({ a: { option: 'yes' } })
    expect(result.current.card.canSend).toBe(true)
  })

  it('shows a refused answer from the outbox, Send enabled, until the user sends again', async () => {
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.send'
        ? { ok: false, error: { code: 'invalid_params', message: 'refused' } }
        : null
    )
    const { result } = render({ submissions: [], fence: 1 })
    answerYes(result)
    await waitFor(() => expect(result.current.card.canSend).toBe(true))
    // Held for the user's Retry, so it won't go out again on its own.
    expect(result.current.outbox.outbox[0]).toMatchObject({
      state: 'queued',
      lastFailure: expect.anything()
    })
    expect(result.current.card.edits).toEqual({ a: { option: 'yes' } })
  })

  it('clears the answer once the host has it; the card waits for the host set', async () => {
    mocks.call.mockImplementation(async (_target, method, params) => {
      if (method !== 'agentSession.send') {
        return null
      }
      const id = params.envelope?.clientOperationId ?? ''
      return {
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'e', sequence: 2 },
        value: { clientMessageId: id, submission: submission(id, { dispatchState: 'accepted' }) }
      }
    })
    const { result } = render({ submissions: [], fence: 1 })
    answerYes(result)
    await waitFor(() => expect(result.current.outbox.outbox).toHaveLength(0))
    expect(result.current.card.open.map((question) => question.key)).toEqual(['a'])
    expect(result.current.card.edits).toEqual({})
    expect(result.current.card.sending).toBe(false)
  })

  it('stays on its way when an owner change puts it back in the queue', async () => {
    hangSends()
    const { result, rerender } = render({ submissions: [], fence: 1 })
    answerYes(result)
    await waitFor(() => expect(result.current.outbox.outbox[0]?.state).toBe('dispatching'))
    rerender({ submissions: [], fence: 2 })
    // Resent under the new owner: still the same entry on its way, never a second answer.
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(result.current.outbox.outbox).toHaveLength(1)
    expect([...result.current.card.held]).toEqual(['a'])
  })
})
