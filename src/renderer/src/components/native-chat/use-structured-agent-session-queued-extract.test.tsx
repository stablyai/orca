import { createRef } from 'react'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import {
  agentSessionSendBodyFingerprint,
  structuredAgentSessionSendBody
} from '../../../../shared/structured-agent-session-send-mutation'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import {
  readNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { extractQueuedMessageToComposer } from './structured-agent-session-queued-extract'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import * as handback from './structured-agent-session-message-hand-back'
import { promptSkillRefs } from './native-chat-prompt-document'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))

const scope = 'queued-extraction'
const image = { url: 'https://example.com/queued.png', alt: 'diagram' }
const skills = [
  { name: 'review', path: '/one/SKILL.md' },
  { name: 'review', path: '/two/SKILL.md' }
]
const message: AgentSessionQueuedMessage = {
  messageId: 'mail',
  position: 1,
  state: 'waiting',
  body: {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: '$review $review [Image #1]' },
      { type: 'image-ref', ...image }
    ],
    skills,
    from: { kind: 'agent', senders: [], orchestration: null }
  }
}

// A pasted-text leaf before the selections must not shift which occurrence binds which file.
const pasted = '[Pasted text](orca-paste:12345678-1234-1234-1234-123456789abc)'
const pastedMessage: AgentSessionQueuedMessage = {
  ...message,
  body: {
    ...message.body,
    blocks: [
      { type: 'text', text: `${pasted} $review $review [Image #1]` },
      message.body.blocks[1]!
    ]
  }
}

afterEach(() => {
  cleanup()
  clearNativeChatDraftCacheForTests()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function harness(write: StructuredAgentSessionWrite, prompt = false, queued = message) {
  const send = vi.fn<NativeChatStructuredComposerTransport['send']>(() => true)
  const transport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    send,
    runtime: 'local',
    sessionId: 'session',
    runtimeEnvironmentId: null,
    onError: vi.fn(),
    optionSnapshot: [],
    dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: async () => ({ snapshot: [] }),
      invokeAction: async () => ({ snapshot: [] }),
      subscribe: () => () => {}
    }
  }
  const mutate = vi.fn(async () => null)
  const hook = renderHook(() => {
    const queue = useStructuredAgentSessionQueuedMessages({
      admit: () => null,
      capturePresentation: () => () => true,
      enabled: true,
      queuedMessages: [queued],
      queuePause: { reason: 'stopped' },
      submissions: [],
      hasPendingPrompt: prompt,
      isWorking: false,
      composerScopeKey: scope,
      mutate,
      editTransport: {
        target: { kind: 'local' },
        sessionId: 'session',
        capable: true,
        copyDeleteCapable: true,
        write
      }
    })
    const draft = readNativeChatComposerDraft(scope)
    const submit = useNativeChatStructuredComposerSend({
      agent: 'codex',
      draftScopeKey: scope,
      imageAttachments: draft.images,
      structuredTransport: transport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: (text) => updateNativeChatComposerDraft(scope, { text }, 'immediate'),
      setCaret: vi.fn()
    })
    return { queue, submit }
  })
  return { ...hook, send, mutate }
}

it.each([
  ['its text', '', message],
  ['a pasted-text leaf', `${pasted} `, pastedMessage]
])(
  'durably appends full mail with %s before conditional Delete, then sends it as an ordinary user message',
  async (_label, lead, queued) => {
    const storage = createMemoryNativeChatComposerDraftStorage()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    const old = { name: 'old', path: '/legacy/SKILL.md' }
    updateNativeChatComposerDraft(
      scope,
      {
        text: 'already typing $old',
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'already typing ' },
                { type: 'nativeChatSkill', attrs: { token: '$old', path: old.path } }
              ]
            }
          ]
        }
      },
      'immediate'
    )
    const calls = vi.fn((..._args: unknown[]) => {})
    const write: StructuredAgentSessionWrite = async <T,>(
      ...args: Parameters<StructuredAgentSessionWrite>
    ) => {
      calls(...args)
      const draft = readNativeChatComposerDraft(scope)
      expect(draft.text).toContain(`already typing $old\n\n${lead}$review`)
      expect(draft.images[0]?.reference).toEqual(image)
      expect(draft.document?.content?.flatMap((node) => node.content ?? [])).toContainEqual({
        type: 'nativeChatSkill',
        attrs: { token: '$review', path: skills[0]?.path }
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this flow issues only queuedMessageDelete.
      return { kind: 'done', value: { deleted: true, messageId: 'mail' } as T }
    }
    let hook = harness(write, false, queued)
    await act(() => hook.result.current.queue.edit('mail'))
    expect(hook.result.current.queue.editor).toBeUndefined()
    expect(calls).toHaveBeenCalledExactlyOnceWith(
      'agentSession.queuedMessageDelete',
      'agentSession.queuedMessageDelete',
      {
        messageId: 'mail',
        expectedBodyFingerprint: agentSessionSendBodyFingerprint('session', queued.body)
      }
    )
    await nativeChatComposerDraftWritesSettled()
    hook.unmount()
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    const draft = readNativeChatComposerDraft(scope)
    const inputRef = createRef<NativeChatComposerInput>()
    const editor = render(
      <NativeChatPromptEditor
        inputRef={inputRef}
        scopeKey={scope}
        initialValue={draft.text}
        disabled={false}
        placeholder="Message"
        onChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    await waitFor(() =>
      expect(editor.container.querySelectorAll('[data-native-chat-skill]')).toHaveLength(3)
    )
    expect(inputRef.current?.value).toBe(draft.text)
    expect(promptSkillRefs(draft.document)).toEqual([old, ...skills])
    hook = harness(write, false, queued)
    await act(() => hook.result.current.submit(inputRef.current?.value ?? ''))
    if (lead) {
      // An unsaved paste stays literal: Send refuses it and keeps the whole draft.
      expect(hook.send).not.toHaveBeenCalled()
      expect(readNativeChatComposerDraft(scope).text).toBe(draft.text)
      return
    }
    const [text, attachments, request] = hook.send.mock.calls[0]!
    const sent = structuredAgentSessionSendBody(
      text,
      attachments.map((attachment) => ({ ...attachment, previewUri: '' })),
      request?.skills
    )
    expect(sent).toEqual({
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: `already typing $old\n\n${lead}$review $review [Image #1]` },
        { type: 'image-ref', ...image }
      ],
      skills: [old, ...skills]
    })
    expect(hook.mutate).not.toHaveBeenCalled()
    expect(readNativeChatComposerDraft(scope).text).toBe('')
  }
)

it('retains the copied draft after Delete refusal and appends again on a deliberate retry', async () => {
  const write: StructuredAgentSessionWrite = async () => ({
    kind: 'not-done',
    notice: 'This queued message changed.',
    failure: { kind: 'refused', code: 'agent_session_operation_invalid' }
  })
  const hook = harness(write)
  await act(() => hook.result.current.queue.edit('mail'))
  await act(() => hook.result.current.queue.edit('mail'))
  const draft = readNativeChatComposerDraft(scope)
  expect(draft.images).toHaveLength(2)
  expect(draft.images[0]?.id).not.toBe(draft.images[1]?.id)
  expect(draft.text.match(/\$review/gu)).toHaveLength(4)
  expect(toast.error).toHaveBeenCalledTimes(2)
  expect(toast.error).toHaveBeenLastCalledWith(
    'This queued message changed. A copy is in the chat box.'
  )
})

it('keeps the card when draft storage refuses or a question/approval is open', async () => {
  const write: StructuredAgentSessionWrite = vi.fn(async () => ({ kind: 'dropped' as const }))
  const blocked = harness(write, true)
  await act(() => blocked.result.current.queue.edit('mail'))
  expect(blocked.result.current.queue.editDisabledReason).toContain('before editing')
  expect(readNativeChatComposerDraft(scope).text).toBe('')
  blocked.unmount()
  vi.spyOn(handback, 'returnMessageToComposer').mockReturnValue(false)
  const hook = harness(write)
  await act(() => hook.result.current.queue.edit('mail'))
  expect(write).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledOnce()
  expect(hook.result.current.queue.cards[0]?.messageId).toBe('mail')
})

it.each([true, false])(
  'acknowledges the captured large addition transaction before Delete (hydrated=%s)',
  async (hydrated) => {
    const storage = createMemoryNativeChatComposerDraftStorage()
    const text = `${'\n'.repeat(24_000)}$review`
    const body = structuredAgentSessionSendBody(text, [], [skills[0]!])
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = storage.write
    const update = storage.update
    if (hydrated) {
      storage.write = async (...args) => {
        await gate
        return write(...args)
      }
    } else {
      storage.update = async (...args) => {
        await gate
        return update(...args)
      }
    }
    setNativeChatComposerDraftStorageForTests(storage)
    if (hydrated) {
      await hydrateNativeChatComposerDrafts()
    }
    const deleted = vi.fn(async () => ({ kind: 'dropped' as const }))
    const pending = extractQueuedMessageToComposer(
      { target: { kind: 'local' }, sessionId: 'session', capable: true, write: deleted },
      scope,
      { ...message, body }
    )
    updateNativeChatComposerDraft(scope, { text: 'new typing', document: undefined }, 'deferred')
    await Promise.resolve()
    expect(deleted).not.toHaveBeenCalled()
    release()
    await pending
    expect(deleted).toHaveBeenCalledOnce()
    expect(storage.drafts.get(scope)?.text.endsWith(text)).toBe(true)
    expect(readNativeChatComposerDraft(scope).text).toBe('new typing')
    await nativeChatComposerDraftWritesSettled()
  }
)

it('keeps the queue source after captured large-copy refusal even when replacement text later saves', async () => {
  const storage = createMemoryNativeChatComposerDraftStorage()
  let refuse = (_reason: Error) => {}
  storage.write = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject
        })
    )
    .mockImplementation(async (key, draft) => {
      storage.drafts.set(key, draft)
    })
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
  const deleted = vi.fn(async () => ({ kind: 'dropped' as const }))
  const body = structuredAgentSessionSendBody(`${'\n'.repeat(24_000)}$review`, [], [skills[0]!])
  const pending = extractQueuedMessageToComposer(
    { target: { kind: 'local' }, sessionId: 'session', capable: true, write: deleted },
    scope,
    {
      ...message,
      body
    }
  )
  updateNativeChatComposerDraft(scope, { text: 'replacement', document: undefined }, 'deferred')
  refuse(new Error('copy refused'))
  await pending
  expect(deleted).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledOnce()
  await nativeChatComposerDraftWritesSettled()
  expect(readNativeChatComposerDraft(scope).text).toBe('replacement')
})
