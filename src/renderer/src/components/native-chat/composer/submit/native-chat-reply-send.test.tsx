// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import { useNativeChatDraft } from '../../drafts/use-native-chat-draft'
import { deleteNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-removal'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../../../shared/agent-session/view/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import {
  cancelNativeChatReplyTarget,
  nativeChatReplyTargetFromSentText,
  readNativeChatReplyTarget,
  resetNativeChatReplyTargetsForTests,
  setNativeChatReplyTarget
} from '../reply/native-chat-reply-target'
import { withNativeChatReplyContext } from '../reply/native-chat-reply-quote'
import {
  NATIVE_CHAT_REPLY_SOURCE_AMBIGUOUS,
  nativeChatReplySourceOf,
  rememberNativeChatReplySource,
  resetNativeChatReplySourcesForTests
} from '../reply/native-chat-reply-sources'
import { nativeChatReplyRevealId } from '../reply/native-chat-reply-original'

vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))

const scope = 'agent-session:reply'
const target = {
  id: 'reply-1',
  messageId: 'm-7',
  author: 'agent' as const,
  excerpt: 'Updated the three cards.\nThe Continue button is blue now.'
}

function fixture(accept: boolean | (() => Promise<boolean>)) {
  const transport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    send: vi.fn(() => (typeof accept === 'function' ? accept() : accept)),
    dispatchCommand: (text) =>
      dispatchStructuredAgentSessionComposerCommand(text, {
        agent: 'codex',
        snapshot: [],
        invokeAction: async () => true,
        setOption: async () => true
      }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'reply',
    runtimeEnvironmentId: null
  }
  const hook = renderHook(() => {
    const draft = useNativeChatDraft(scope, () => false)
    return useNativeChatStructuredComposerSend({
      agent: 'codex',
      draftScopeKey: scope,
      imageAttachments: [],
      structuredTransport: transport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: draft.setDraft,
      setCaret: vi.fn()
    })
  })
  return { transport, send: (text: string) => hook.result.current(text, []) }
}

describe('replying to a message from a structured chat', () => {
  beforeEach(async () => {
    localStorage.clear()
    resetNativeChatReplyTargetsForTests()
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
    await hydrateNativeChatComposerDrafts()
  })
  afterEach(() => {
    cleanup()
    clearNativeChatComposerDraftsForTests()
  })

  it('sends the quote once before the text and clears the reply when accepted', async () => {
    setNativeChatReplyTarget(scope, target)
    const { transport, send } = fixture(true)
    await act(async () => {
      await send('Why blue?')
    })
    expect(transport.send).toHaveBeenCalledWith(
      '> Replying to the earlier message from Codex:\n> Updated the three cards.\n> The Continue button is blue now.\n\nWhy blue?',
      []
    )
    expect(readNativeChatReplyTarget(scope)).toBeNull()
  })

  it('keeps the reply when the send is refused', async () => {
    setNativeChatReplyTarget(scope, target)
    const { send } = fixture(false)
    await act(async () => {
      await send('Why blue?')
    })
    expect(readNativeChatReplyTarget(scope)?.id).toBe('reply-1')
  })

  it('keeps a newer reply picked while the send was in flight', async () => {
    setNativeChatReplyTarget(scope, target)
    const admission = Promise.withResolvers<boolean>()
    const { send } = fixture(() => admission.promise)
    let pending: Promise<boolean> | undefined
    act(() => {
      pending = send('Why blue?')
    })
    setNativeChatReplyTarget(scope, { ...target, id: 'reply-2', messageId: 'm-9' })
    await act(async () => {
      admission.resolve(true)
      await pending
    })
    expect(readNativeChatReplyTarget(scope)?.id).toBe('reply-2')
  })

  it('brings the reply back when a pending send is refused or fails', async () => {
    for (const outcome of ['refused', 'failed'] as const) {
      setNativeChatReplyTarget(scope, target)
      const admission = Promise.withResolvers<boolean>()
      const { send } = fixture(() => admission.promise)
      let pending: Promise<boolean> | undefined
      // The hand-off waits on the command check; flushing it lets the pending send take the reply.
      await act(async () => {
        pending = send('Why blue?')
      })
      expect(readNativeChatReplyTarget(scope)).toBeNull()
      await act(async () => {
        if (outcome === 'refused') {
          admission.resolve(false)
        } else {
          admission.reject(new Error('write failed'))
        }
        await pending
      })
      expect(readNativeChatReplyTarget(scope)?.id).toBe('reply-1')
      cleanup()
    }
  })

  it('keeps a reply picked during a pending send that is then refused', async () => {
    setNativeChatReplyTarget(scope, target)
    const admission = Promise.withResolvers<boolean>()
    const { send } = fixture(() => admission.promise)
    let pending: Promise<boolean> | undefined
    act(() => {
      pending = send('Why blue?')
    })
    setNativeChatReplyTarget(scope, { ...target, id: 'reply-2', messageId: 'm-9' })
    await act(async () => {
      admission.resolve(false)
      await pending
    })
    expect(readNativeChatReplyTarget(scope)?.id).toBe('reply-2')
  })

  it('does not bring a reply back after its chat was deleted or a newer reply was cancelled', async () => {
    for (const decide of [
      () => deleteNativeChatComposerDraft(scope),
      () => {
        setNativeChatReplyTarget(scope, { ...target, id: 'reply-2' })
        cancelNativeChatReplyTarget(scope)
      }
    ]) {
      setNativeChatReplyTarget(scope, target)
      const admission = Promise.withResolvers<boolean>()
      const { send } = fixture(() => admission.promise)
      let pending: Promise<boolean> | undefined
      await act(async () => {
        pending = send('Why blue?')
      })
      decide()
      await act(async () => {
        admission.resolve(false)
        await pending
      })
      expect(readNativeChatReplyTarget(scope)).toBeNull()
      cleanup()
    }
  })

  it('never quotes a command and leaves the reply for the next message', async () => {
    setNativeChatReplyTarget(scope, target)
    const { transport, send } = fixture(true)
    await act(async () => {
      await send('/compact')
    })
    expect(transport.send).not.toHaveBeenCalled()
    expect(readNativeChatReplyTarget(scope)?.id).toBe('reply-1')
  })
})

const runtimeSend = vi.hoisted(() => ({
  sendNativeChatMessage: vi.fn(() => ({})),
  sendNativeChatTypedCommand: vi.fn(() => ({})),
  sendWithImages: vi.fn((): { outcome?: Promise<'not-submitted' | 'submitted'> } => ({}))
}))
vi.mock('../../session/terminal/send/native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: runtimeSend.sendWithImages
}))
vi.mock('../../session/terminal/send/native-chat-runtime-send', async (load) => ({
  ...(await load<object>()),
  sendNativeChatMessage: runtimeSend.sendNativeChatMessage,
  sendNativeChatTypedCommand: runtimeSend.sendNativeChatTypedCommand
}))

describe('replying to a message from a terminal chat', () => {
  const ptyScope = 'pane:reply'
  beforeEach(async () => {
    localStorage.clear()
    resetNativeChatReplyTargetsForTests()
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
    await hydrateNativeChatComposerDrafts()
    runtimeSend.sendNativeChatMessage.mockClear()
    runtimeSend.sendNativeChatTypedCommand.mockClear()
    runtimeSend.sendWithImages.mockClear()
  })
  afterEach(() => cleanup())

  function ptySend(
    draft: string,
    classification: 'chat' | 'command' | 'unknown-token' = 'chat',
    imagePaths: string[] = [],
    inputLine = '',
    onOptimisticSend?: () => string | undefined
  ) {
    const hook = renderHook(() =>
      useNativeChatPtyComposerSend({
        agent: 'codex',
        draft,
        draftScopeKey: ptyScope,
        imageAttachments: imagePaths.map((path) => ({ path })),
        disabled: false,
        isDispatchingSessionOption: false,
        launchDraftResolved: true,
        resolveTarget: (): NativeChatResolvedTarget => ({ ptyId: 'pty-1' }),
        readTerminalDraft: () => inputLine,
        onOptimisticSend,
        classifySend: () => classification,
        sessionOptionsSurface: null,
        terminalTabId: 'tab-1',
        trackPendingSend: vi.fn(),
        setDraft: vi.fn(),
        setCaret: vi.fn(),
        clearSkillOrigin: vi.fn(),
        clearImageAttachments: vi.fn(),
        setNotice: vi.fn()
      })
    )
    return hook.result.current
  }

  it('quotes once, clears the reply, and a retry resends its own text without the newer reply', () => {
    setNativeChatReplyTarget(ptyScope, target)
    const send = ptySend('Why blue?')
    act(() => {
      send()
    })
    const quoted =
      '> Replying to the earlier message from Codex:\n> Updated the three cards.\n> The Continue button is blue now.\n\nWhy blue?'
    expect(runtimeSend.sendNativeChatMessage).toHaveBeenLastCalledWith(
      'pty-1',
      quoted,
      expect.anything()
    )
    expect(readNativeChatReplyTarget(ptyScope)).toBeNull()
    setNativeChatReplyTarget(ptyScope, { ...target, id: 'reply-2', author: 'user' })
    act(() => {
      send({ text: quoted })
    })
    expect(runtimeSend.sendNativeChatMessage).toHaveBeenLastCalledWith(
      'pty-1',
      quoted,
      expect.anything()
    )
    expect(readNativeChatReplyTarget(ptyScope)?.id).toBe('reply-2')
  })

  it('quotes an unknown slash token sent with an image, and gets the reply back if the write is rejected', async () => {
    setNativeChatReplyTarget(ptyScope, target)
    let settle: (outcome: 'not-submitted') => void = () => {}
    runtimeSend.sendWithImages.mockReturnValueOnce({
      outcome: new Promise((resolve) => {
        settle = resolve
      })
    })
    const send = ptySend('/Users/me/shot.png looks off', 'unknown-token', ['/tmp/shot.png'])
    act(() => {
      send()
    })
    expect(runtimeSend.sendWithImages).toHaveBeenCalledWith(
      'codex',
      'pty-1',
      '> Replying to the earlier message from Codex:\n> Updated the three cards.\n> The Continue button is blue now.\n\n/Users/me/shot.png looks off',
      ['/tmp/shot.png'],
      expect.anything()
    )
    expect(readNativeChatReplyTarget(ptyScope)).toBeNull()
    await act(async () => settle('not-submitted'))
    expect(readNativeChatReplyTarget(ptyScope)?.id).toBe('reply-1')
    // The terminal never took it, so it answers nothing: no original is remembered for these words.
    expect(
      nativeChatReplySourceOf(
        withNativeChatReplyContext('/Users/me/shot.png looks off', target, 'Codex')
      )
    ).toBeUndefined()
  })

  it('a terminal reply shown as not sent keeps its exact original for Edit', async () => {
    setNativeChatReplyTarget(ptyScope, target)
    let settle: (outcome: 'not-submitted') => void = () => {}
    runtimeSend.sendWithImages.mockReturnValueOnce({
      outcome: new Promise((resolve) => {
        settle = resolve
      })
    })
    // The message shows in the chat, so a rejected write comes back as "not sent → Edit".
    const send = ptySend('Why is it blue?', 'chat', ['/tmp/shot.png'], '', () => 'pending-1')
    act(() => {
      send()
    })
    await act(async () => settle('not-submitted'))
    expect(readNativeChatReplyTarget(ptyScope)).toBeNull()
    const sent = withNativeChatReplyContext('Why is it blue?', target, 'Codex')
    expect(nativeChatReplyTargetFromSentText(sent).target?.messageId).toBe(target.messageId)
  })

  it('remembers the original of a terminal reply once the terminal takes the write', async () => {
    setNativeChatReplyTarget(ptyScope, target)
    let settle: (outcome: 'submitted') => void = () => {}
    runtimeSend.sendWithImages.mockReturnValueOnce({
      outcome: new Promise((resolve) => {
        settle = resolve
      })
    })
    const send = ptySend('Is this right?', 'chat', ['/tmp/shot.png'])
    act(() => {
      send()
    })
    const sent = withNativeChatReplyContext('Is this right?', target, 'Codex')
    expect(nativeChatReplySourceOf(sent)).toBeUndefined()
    await act(async () => settle('submitted'))
    expect(nativeChatReplySourceOf(sent)).toBe(target.messageId)
  })

  it('types a command as-is, with or without an image, and keeps the reply', () => {
    setNativeChatReplyTarget(ptyScope, target)
    const command = ptySend('/compact', 'command')
    act(() => {
      command()
    })
    expect(runtimeSend.sendNativeChatTypedCommand).toHaveBeenCalledWith(
      'pty-1',
      '/compact',
      expect.anything()
    )
    const commandWithImage = ptySend('/review', 'command', ['/tmp/shot.png'])
    act(() => {
      commandWithImage()
    })
    expect(runtimeSend.sendWithImages).toHaveBeenCalledWith(
      'codex',
      'pty-1',
      '/review',
      ['/tmp/shot.png'],
      expect.anything()
    )
    expect(readNativeChatReplyTarget(ptyScope)?.id).toBe('reply-1')
  })
})

describe('remembering which message a reply answered', () => {
  it('an accepted structured send records the reply it quoted, even if another was picked meanwhile', async () => {
    localStorage.clear()
    resetNativeChatReplySourcesForTests()
    setNativeChatReplyTarget(scope, target)
    const { send } = fixture(true)
    await act(async () => {
      const pending = send('Why blue?')
      setNativeChatReplyTarget(scope, { ...target, id: 'reply-2', messageId: 'm-9' })
      await pending
    })
    expect(nativeChatReplySourceOf(withNativeChatReplyContext('Why blue?', target, 'Codex'))).toBe(
      'm-7'
    )
  })

  it('a structured reply ending in a space or newline keeps its exact original among duplicates', async () => {
    localStorage.clear()
    resetNativeChatReplySourcesForTests()
    // Two answers with the same words: only the recorded id tells them apart.
    const second = { ...target, id: 'reply-dup', messageId: 'm-second' }
    setNativeChatReplyTarget(scope, second)
    const { send } = fixture(true)
    await act(async () => {
      await send('Which one? \n')
    })
    // The message stores its words without trailing whitespace; Rewind and Edit read them so.
    const stored = withNativeChatReplyContext('Which one? \n', second, 'Codex').trimEnd()
    const rebuilt = nativeChatReplyTargetFromSentText(stored).target!
    expect(rebuilt.messageId).toBe('m-second')
    const duplicates = ['m-first', 'm-second'].map((id) => ({
      id,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: target.excerpt }]
    }))
    expect(
      nativeChatReplyRevealId(
        rebuilt,
        () => true,
        () => duplicates
      )
    ).toBe('m-second')
    // With that original gone, it stays unavailable rather than taking the other duplicate.
    expect(
      nativeChatReplyRevealId(
        rebuilt,
        () => false,
        () => duplicates.slice(0, 1)
      )
    ).toBeNull()
  })

  it('a refused structured send records nothing', async () => {
    localStorage.clear()
    resetNativeChatReplySourcesForTests()
    setNativeChatReplyTarget(scope, target)
    const { send } = fixture(async () => false)
    await act(async () => {
      await send('Why blue?')
    })
    expect(
      nativeChatReplySourceOf(withNativeChatReplyContext('Why blue?', target, 'Codex'))
    ).toBeUndefined()
  })

  beforeEach(() => {
    localStorage.clear()
    resetNativeChatReplyTargetsForTests()
    resetNativeChatReplySourcesForTests()
  })

  it('records nothing for a terminal send that is not sent', () => {
    setNativeChatReplyTarget('pane:unsent', { ...target, messageId: 'm-original' })
    const { result } = renderHook(() =>
      useNativeChatPtyComposerSend({
        agent: 'codex',
        draft: 'Why blue?',
        draftScopeKey: 'pane:unsent',
        imageAttachments: [],
        disabled: false,
        isDispatchingSessionOption: false,
        launchDraftResolved: true,
        resolveTarget: (): NativeChatResolvedTarget => ({ ptyId: 'pty-1' }),
        // An input line too tall to clear: the send stops with "Message not sent".
        readTerminalDraft: () => 'line\n'.repeat(400),
        classifySend: () => 'chat',
        sessionOptionsSurface: null,
        terminalTabId: 'tab-1',
        trackPendingSend: vi.fn(),
        setDraft: vi.fn(),
        setCaret: vi.fn(),
        clearSkillOrigin: vi.fn(),
        clearImageAttachments: vi.fn(),
        setNotice: vi.fn()
      })
    )
    act(() => {
      result.current()
    })
    const quoted = withNativeChatReplyContext('Why blue?', target, 'Codex')
    expect(nativeChatReplySourceOf(quoted)).toBeUndefined()
    expect(readNativeChatReplyTarget('pane:unsent')?.messageId).toBe('m-original')
  })

  it('claims no exact original for the same words sent in reply to two different messages', () => {
    const sent = withNativeChatReplyContext(
      'Which one?',
      { author: 'agent', excerpt: 'Done.' },
      'Claude'
    )
    rememberNativeChatReplySource(sent, 'm-first')
    expect(nativeChatReplySourceOf(sent)).toBe('m-first')
    rememberNativeChatReplySource(sent, 'm-second')
    expect(nativeChatReplySourceOf(sent)).toBe(NATIVE_CHAT_REPLY_SOURCE_AMBIGUOUS)
  })
})
