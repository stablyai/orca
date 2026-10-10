// @vitest-environment happy-dom

// The inline editor's lifecycle against a scripted host: what it acquires and saves, and that
// typing is never lost — a card that leaves mid-edit puts dirty text in the chat box, and lease
// bookkeeping failing never gates typing, Save or Cancel.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageEditHoldParams,
  AgentSessionQueuedMessageEditHoldResult,
  AgentSessionQueuedMessageUpdateResult
} from '../../../../shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import { useStructuredAgentSessionQueuedEdit } from './use-structured-agent-session-queued-edit'
import { projectQueuedMessageCards } from './structured-agent-session-queued-cards'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import type {
  StructuredAgentSessionWrite,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'

const HELD: AgentSessionQueuedMessageEditHoldResult = {
  status: 'held',
  fingerprint: 'f'.repeat(64),
  leaseDurationMs: 120_000,
  remainingMs: 120_000
}
const rpc = vi.hoisted(() =>
  vi.fn(
    async (
      _target: unknown,
      _method: string,
      params: AgentSessionQueuedMessageEditHoldParams
    ): Promise<AgentSessionQueuedMessageEditHoldResult> =>
      params.action === 'release' ? { status: 'released' } : HELD
  )
)
vi.mock('@/runtime/structured-agent-session-client', () => ({ callStructuredAgentSession: rpc }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const SESSION = 'folder-session'
const SCOPE = 'pane-draft'
const message: AgentSessionQueuedMessage = {
  messageId: 'card',
  position: 2,
  state: 'waiting',
  body: {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'original' }],
    from: { kind: 'agent', senders: [], orchestration: null }
  }
}
const BASE = agentSessionSendBodyFingerprint(SESSION, message.body)

type Outcome = StructuredAgentSessionWriteOutcome<AgentSessionQueuedMessageUpdateResult>
let answer: () => Promise<Outcome>
const writeSpy = vi.fn(async (..._args: unknown[]) => answer())
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this harness answers only queuedMessageUpdate, with that method's scripted outcome.
const write = writeSpy as StructuredAgentSessionWrite

type Props = {
  messages: AgentSessionQueuedMessage[] | null
  sessionId?: string
  submissions?: AgentJournalSubmission[]
  promptOpen?: boolean
}
function harness(capable = true, initial: Props = { messages: [message] }) {
  return renderHook(
    (props: Props) => {
      const submissions = props.submissions ?? []
      return useStructuredAgentSessionQueuedEdit({
        transport: {
          target: { kind: 'environment', environmentId: 'remote-host' },
          sessionId: props.sessionId ?? SESSION,
          capable,
          write
        },
        messages: props.messages,
        cards: projectQueuedMessageCards(props.messages, submissions, { hasPendingPrompt: true }),
        submissions,
        composerScopeKey: SCOPE,
        promptOpen: props.promptOpen ?? false
      })
    },
    { initialProps: initial }
  )
}
type Hook = ReturnType<typeof harness>
async function begin(hook: Hook) {
  await act(() => hook.result.current.begin('card'))
}
function holdCalls(action: string) {
  return rpc.mock.calls.filter((call) => call[2].action === action)
}
function done(value: AgentSessionQueuedMessageUpdateResult): () => Promise<Outcome> {
  return async () => ({ kind: 'done', value })
}
function withText(text: string): AgentSessionQueuedMessage {
  return { ...message, body: { ...message.body, blocks: [{ type: 'text', text }] } }
}
function submittedAs(text: string): AgentJournalSubmission {
  return {
    clientMessageId: 'submission',
    queuedMessageId: 'card',
    payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, withText(text).body),
    fence: 3,
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}

beforeEach(() => {
  rpc.mockClear()
  writeSpy.mockClear()
  vi.mocked(toast.error).mockClear()
  clearNativeChatDraftCacheForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  answer = done({ status: 'updated', messageId: 'card', fingerprint: 'a'.repeat(64) })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('inline queued editor', () => {
  it('holds the card on its host, saves against the full body, and leaves the chat box alone', async () => {
    writeNativeChatDraftCache(SCOPE, 'existing composer')
    const hook = harness()
    await begin(hook)
    expect(rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'remote-host' },
      'agentSession.queuedMessageEditHold',
      expect.objectContaining({
        sessionId: SESSION,
        action: 'acquire',
        expectedBodyFingerprint: BASE
      })
    )
    expect(hook.result.current.editor).toMatchObject({ text: 'original', acquiring: false })
    act(() => hook.result.current.editor?.change('edited'))
    act(() => hook.result.current.editor?.save())
    await waitFor(() => expect(hook.result.current.editor).toBeUndefined())
    expect(writeSpy).toHaveBeenCalledWith(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      { messageId: 'card', expectedBodyFingerprint: BASE, text: 'edited' }
    )
    await waitFor(() => expect(holdCalls('release')).toHaveLength(1))
    expect(holdCalls('release')[0]?.[2].editId).toBe(holdCalls('acquire')[0]?.[2].editId)
    expect(readNativeChatDraftCache(SCOPE)).toBe('existing composer')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a host that cannot edit in place gets no editor and no request', async () => {
    const hook = harness(false)
    await begin(hook)
    expect(hook.result.current.editor).toBeUndefined()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('opens one editor per pane', async () => {
    const second = { ...message, messageId: 'second', position: 3 }
    const hook = harness(true, { messages: [message, second] })
    await begin(hook)
    await act(() => hook.result.current.begin('second'))
    expect(hook.result.current.editor?.messageId).toBe('card')
    expect(holdCalls('acquire')).toHaveLength(1)
  })

  it('Save with the text unchanged writes nothing', async () => {
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.save())
    expect(hook.result.current.editor).toBeUndefined()
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('Cancel during a slow acquire closes at once and releases that edit after it lands', async () => {
    let finish: (value: AgentSessionQueuedMessageEditHoldResult) => void = () => {}
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const hook = harness()
    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = hook.result.current.begin('card')
    })
    expect(hook.result.current.editor?.acquiring).toBe(true)
    act(() => hook.result.current.editor?.cancel())
    expect(hook.result.current.editor).toBeUndefined()
    expect(holdCalls('release')).toHaveLength(0)
    await act(async () => {
      finish(HELD)
      await pending
    })
    await waitFor(() => expect(holdCalls('release')).toHaveLength(1))
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('a card sent elsewhere moves dirty typing into the chat box, after its draft, with one toast', async () => {
    writeNativeChatDraftCache(SCOPE, 'existing')
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('unsaved'))
    hook.rerender({ messages: [] })
    expect(hook.result.current.editor).toBeUndefined()
    expect(readNativeChatDraftCache(SCOPE)).toBe('existing\n\nunsaved')
    expect(toast.error).toHaveBeenCalledTimes(1)
    hook.rerender({ messages: [] })
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('a clean edit whose card leaves just closes; an unloaded list proves nothing', async () => {
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('typing'))
    hook.rerender({ messages: null })
    expect(hook.result.current.editor?.text).toBe('typing')
    act(() => hook.result.current.editor?.change('original'))
    hook.rerender({ messages: [] })
    expect(hook.result.current.editor).toBeUndefined()
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('changed puts the typing in the chat box and reopens on the newer text once it shows', async () => {
    writeNativeChatDraftCache(SCOPE, 'existing')
    answer = done({ status: 'changed', messageId: 'card' })
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('local'))
    act(() => hook.result.current.editor?.save())
    await waitFor(() => expect(hook.result.current.editor).toBeUndefined())
    expect(readNativeChatDraftCache(SCOPE)).toBe('existing\n\nlocal')
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'This message changed while you were editing. Your edit is in the chat box.'
    )
    // The newer text has not reached this pane yet: nothing opens on the old one.
    hook.rerender({ messages: [message] })
    expect(hook.result.current.editor).toBeUndefined()
    const remote = withText('remote')
    hook.rerender({ messages: [remote] })
    await waitFor(() => expect(hook.result.current.editor).toMatchObject({ text: 'remote' }))
    expect(holdCalls('acquire')[1]?.[2]).toMatchObject({
      expectedBodyFingerprint: agentSessionSendBodyFingerprint(SESSION, remote.body)
    })
    expect(writeSpy).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledOnce()
  })

  it('while a question holds the chat box, the notice says when the edit will be there', async () => {
    answer = done({ status: 'gone', messageId: 'card', disposition: 'dispatched' })
    const hook = harness(true, { messages: [message], promptOpen: true })
    await begin(hook)
    act(() => hook.result.current.editor?.change('unsaved'))
    act(() => hook.result.current.editor?.save())
    await waitFor(() => expect(hook.result.current.editor).toBeUndefined())
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'This message was already sent or removed. Your edit will be in the chat box after you answer the agent.'
    )
    expect(readNativeChatDraftCache(SCOPE)).toBe('unsaved')
  })

  it('a refused Save says why once and keeps the editor', async () => {
    answer = async () => ({
      kind: 'not-done',
      notice: 'Too much text is waiting in the queue.',
      failure: { kind: 'failed' }
    })
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('long'))
    act(() => hook.result.current.editor?.save())
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Too much text is waiting in the queue.')
    )
    expect(hook.result.current.editor).toMatchObject({ text: 'long', saving: false })
  })

  it('Save answering gone puts the typing in the chat box; another chat keeps it there quietly', async () => {
    answer = done({ status: 'gone', messageId: 'card', disposition: 'dispatched' })
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('unsaved'))
    act(() => hook.result.current.editor?.save())
    await waitFor(() => expect(hook.result.current.editor).toBeUndefined())
    expect(readNativeChatDraftCache(SCOPE)).toBe('unsaved')
    expect(toast.error).toHaveBeenCalledOnce()
    await begin(hook)
    act(() => hook.result.current.editor?.change('another draft'))
    hook.rerender({ messages: [message], sessionId: 'another-session' })
    expect(hook.result.current.editor).toBeUndefined()
    expect(readNativeChatDraftCache(SCOPE)).toBe('unsaved\n\nanother draft')
    expect(toast.error).toHaveBeenCalledOnce()
    await waitFor(() => expect(holdCalls('release')).toHaveLength(2))
  })

  it('closing the pane keeps unsaved typing in the chat box, quietly; clean edits leave nothing', async () => {
    const dirty = harness()
    await begin(dirty)
    act(() => dirty.result.current.editor?.change('unsaved'))
    dirty.unmount()
    expect(readNativeChatDraftCache(SCOPE)).toBe('unsaved')
    const clean = harness()
    await begin(clean)
    clean.unmount()
    expect(readNativeChatDraftCache(SCOPE)).toBe('unsaved')
    expect(toast.error).not.toHaveBeenCalled()
    await waitFor(() => expect(holdCalls('release')).toHaveLength(2))
  })

  it('a reload, which unmounts nothing, keeps unsaved typing in the chat box once', async () => {
    writeNativeChatDraftCache(SCOPE, 'existing')
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('unsaved'))
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(readNativeChatDraftCache(SCOPE)).toBe('existing\n\nunsaved')
    hook.unmount()
    expect(readNativeChatDraftCache(SCOPE)).toBe('existing\n\nunsaved')
    expect(toast.error).not.toHaveBeenCalled()
    await waitFor(() => expect(holdCalls('release')).toHaveLength(1))
  })

  describe('a Save whose answer this pane cannot read reads the published card', () => {
    const dropped: () => Promise<Outcome> = async () => ({ kind: 'dropped' })
    function deferred() {
      let finish: (outcome: Outcome) => void = () => {}
      answer = () =>
        new Promise((resolve) => {
          finish = resolve
        })
      return (outcome: Outcome) => act(async () => finish(outcome))
    }

    it('the card already shows the saved text: the editor closes, quietly', async () => {
      const finish = deferred()
      const hook = harness()
      await begin(hook)
      act(() => hook.result.current.editor?.change('saved'))
      act(() => hook.result.current.editor?.save())
      hook.rerender({ messages: [withText('saved')] })
      await finish({ kind: 'dropped' })
      expect(hook.result.current.editor).toBeUndefined()
      expect(toast.error).not.toHaveBeenCalled()
      expect(readNativeChatDraftCache(SCOPE)).toBe('')
    })

    it('a lost answer for a Save that landed says nothing either', async () => {
      const finish = deferred()
      const hook = harness()
      await begin(hook)
      act(() => hook.result.current.editor?.change('saved'))
      act(() => hook.result.current.editor?.save())
      hook.rerender({ messages: [withText('saved')] })
      await finish({ kind: 'not-done', notice: 'lost', failure: { kind: 'unconfirmed' } })
      expect(hook.result.current.editor).toBeUndefined()
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('the card still shows other text: the editor stays as it was, quietly', async () => {
      answer = dropped
      const hook = harness()
      await begin(hook)
      act(() => hook.result.current.editor?.change('typed'))
      act(() => hook.result.current.editor?.save())
      await waitFor(() => expect(hook.result.current.editor?.saving).toBe(false))
      expect(hook.result.current.editor).toMatchObject({ text: 'typed' })
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('an answer that beats its own publication closes once the card shows the saved text, before it drains', async () => {
      answer = dropped
      const hook = harness()
      await begin(hook)
      act(() => hook.result.current.editor?.change('saved text'))
      act(() => hook.result.current.editor?.save())
      await waitFor(() => expect(hook.result.current.editor?.saving).toBe(false))
      expect(hook.result.current.editor).toMatchObject({ text: 'saved text' })
      hook.rerender({ messages: [withText('saved text')] })
      expect(hook.result.current.editor).toBeUndefined()
      hook.rerender({ messages: [], submissions: [submittedAs('saved text')] })
      expect(toast.error).not.toHaveBeenCalled()
      expect(readNativeChatDraftCache(SCOPE)).toBe('')
    })

    it('a card that drains with exactly the typed text, unseen, closes quietly too', async () => {
      answer = dropped
      const hook = harness()
      await begin(hook)
      act(() => hook.result.current.editor?.change('saved text'))
      act(() => hook.result.current.editor?.save())
      await waitFor(() => expect(hook.result.current.editor?.saving).toBe(false))
      hook.rerender({ messages: [], submissions: [submittedAs('saved text')] })
      expect(hook.result.current.editor).toBeUndefined()
      expect(toast.error).not.toHaveBeenCalled()
      expect(readNativeChatDraftCache(SCOPE)).toBe('')
    })

    it('the card left with its old text (sent elsewhere first): the typing goes to the chat box', async () => {
      const finish = deferred()
      const hook = harness()
      await begin(hook)
      act(() => hook.result.current.editor?.change('typed'))
      act(() => hook.result.current.editor?.save())
      hook.rerender({ messages: [] })
      expect(hook.result.current.editor?.saving).toBe(true)
      await finish({ kind: 'dropped' })
      expect(hook.result.current.editor).toBeUndefined()
      expect(readNativeChatDraftCache(SCOPE)).toBe('typed')
      expect(toast.error).toHaveBeenCalledOnce()
    })
  })

  it('a Save that lands and then drains reads as success, even with its answer lost', async () => {
    let finish: (outcome: Outcome) => void = () => {}
    answer = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('saved text'))
    act(() => hook.result.current.editor?.save())
    hook.rerender({ messages: [], submissions: [submittedAs('saved text')] })
    expect(hook.result.current.editor?.saving).toBe(true)
    await act(async () =>
      finish({ kind: 'not-done', notice: 'lost', failure: { kind: 'unconfirmed' } })
    )
    expect(hook.result.current.editor).toBeUndefined()
    expect(toast.error).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
  })

  it('a failed acquire, renewal or release never gates typing, Save or Cancel, and says nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    rpc.mockRejectedValueOnce(new Error('disconnected'))
    const hook = harness()
    await act(async () => {
      await hook.result.current.begin('card')
    })
    expect(hook.result.current.editor?.acquiring).toBe(false)
    act(() => hook.result.current.editor?.change('still typing'))
    // The lease keeps trying on its own beat: acquire again, then renew.
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(holdCalls('acquire')).toHaveLength(2)
    rpc.mockRejectedValueOnce(new Error('renewal failed'))
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(holdCalls('renew')).toHaveLength(1)
    rpc.mockRejectedValueOnce(new Error('release failed'))
    act(() => hook.result.current.editor?.cancel())
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(hook.result.current.editor).toBeUndefined()
    expect(holdCalls('release')).toHaveLength(1)
    // Ended: no more beats.
    await act(() => vi.advanceTimersByTimeAsync(120_000))
    expect(rpc).toHaveBeenCalledTimes(4)
    expect(toast.error).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a lapsed lease is taken again at once for the same text', async () => {
    vi.useFakeTimers()
    const hook = harness()
    await begin(hook)
    rpc.mockResolvedValueOnce({ status: 'expired' })
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(holdCalls('acquire')).toHaveLength(2)
    expect(holdCalls('acquire')[1]?.[2]).toMatchObject({ expectedBodyFingerprint: BASE })
    act(() => hook.result.current.editor?.cancel())
  })

  it('a card edited or sent before the hold lands closes the editor quietly', async () => {
    rpc.mockResolvedValueOnce({ status: 'changed' })
    const hook = harness()
    await begin(hook)
    expect(hook.result.current.editor).toBeUndefined()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
