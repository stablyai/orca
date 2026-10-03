import { changePrompt, promptValue } from './native-chat-prompt-editor.test-support'
// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as nativeChatAgentProfiles from '../../../../shared/native-chat-agent-profiles'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('./NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => <div data-testid="composer-actions" />
}))
vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('../../store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    agentStatusByPaneKey: {},
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false,
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: () => ({})
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn()
}))
vi.mock('./claude-model-switch-confirmation', () => ({
  createClaudeModelSwitchConfirmationObserver: vi.fn()
}))
vi.mock('../../../../shared/native-chat-agent-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof nativeChatAgentProfiles>()),
  getVerifiedNativeChatCommands: () => []
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('../dictation/dictation-control-events', () => ({
  dispatchDictationControl: vi.fn()
}))

import { NativeChatComposer } from './NativeChatComposer'
import {
  installLocalStorageNativeChatDrafts,
  installNativeChatDrafts
} from './native-chat-draft-store.test-support'
import {
  appendStructuredAgentSessionOutboxMessage,
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import { noteStructuredAgentSessionMessagesDelivered } from './structured-agent-session-message-delivery'
import {
  flushNativeChatDraftPersists,
  type PersistedNativeChatDraft
} from './native-chat-draft-storage'
import {
  appendNativeChatDraftNow,
  clearNativeChatDraftCacheForTests,
  nativeChatDraftKey,
  readNativeChatDraftCache
} from './native-chat-draft-cache'

type Dispatched = { handled: boolean; accepted: boolean; error: string | null }

function deferred(): { promise: Promise<Dispatched>; resolve: (value: Dispatched) => void } {
  let resolve!: (value: Dispatched) => void
  const promise = new Promise<Dispatched>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const PASS_THROUGH: Dispatched = { handled: false, accepted: false, error: null }

function transport(
  overrides: Partial<NativeChatStructuredComposerTransport> = {}
): NativeChatStructuredComposerTransport {
  return {
    send: vi.fn(() => true),
    dispatchCommand: vi.fn(async () => PASS_THROUGH),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'remote',
    sessionId: `session-${paneCounter + 1}`,
    runtimeEnvironmentId: null,
    ...overrides
  }
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

function pressEnter(input: HTMLElement): void {
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false })
}

let paneCounter = 0

// The chat draft of the composer rendered last.
let draftKey = ''

function renderComposer(structuredTransport: NativeChatStructuredComposerTransport): void {
  paneCounter += 1
  const paneKey = `tab-${paneCounter}:structured`
  draftKey = nativeChatDraftKey({ sessionId: structuredTransport.sessionId, paneKey })
  render(
    <NativeChatComposer
      terminalTabId={`tab-${paneCounter}`}
      paneKey={paneKey}
      targetPtyId={null}
      agent="codex"
      structuredTransport={structuredTransport}
    />
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      git: { discoverCommitMessageModels: vi.fn().mockResolvedValue({ success: false }) },
      pty: { getMainBufferSnapshot: vi.fn().mockResolvedValue(null) },
      ui: { onFileDrop: () => vi.fn() }
    }
  })
  installLocalStorageNativeChatDrafts()
})

afterEach(() => cleanup())

describe('structured send racing the next IME composition', () => {
  // The regression: the RPC's clear lands while the NEXT composition is live, so the DOM sync
  // drops it and settlement used to adopt the sent text back into the composer (#17359).
  it('does not resurrect the sent message when the clear lands mid-composition', async () => {
    const dispatch = deferred()
    const structured = transport({ dispatchCommand: vi.fn(() => dispatch.promise) })
    renderComposer(structured)
    const input = textarea()

    changePrompt(input, '안녕')
    pressEnter(input)
    expect(structured.dispatchCommand).toHaveBeenCalledWith('안녕')

    fireEvent.compositionStart(input)
    changePrompt(input, '안녕하')

    await act(async () => {
      dispatch.resolve(PASS_THROUGH)
      await dispatch.promise
    })
    fireEvent.compositionEnd(input, { data: '하' })

    expect(promptValue(input)).toBe('하')

    await act(async () => pressEnter(input))
    expect(structured.send).toHaveBeenLastCalledWith('하', [])
  })

  it('keeps the composed text when a mid-composition clear lands away from the caret', async () => {
    const dispatch = deferred()
    const structured = transport({ dispatchCommand: vi.fn(() => dispatch.promise) })
    renderComposer(structured)
    const input = textarea()

    changePrompt(input, 'abcd')
    pressEnter(input)

    fireEvent.compositionStart(input)
    changePrompt(input, 'ab가cd')

    await act(async () => {
      dispatch.resolve(PASS_THROUGH)
      await dispatch.promise
    })
    fireEvent.compositionEnd(input, { data: '가' })

    expect(promptValue(input)).toBe('가')
  })

  // The message is cleared just before the transport takes it, so a refusal must put it back.
  it('keeps the draft when the send is rejected', async () => {
    const structured = transport({ send: vi.fn(() => false) })
    renderComposer(structured)
    const input = textarea()

    changePrompt(input, '안녕')
    await act(async () => pressEnter(input))

    expect(structured.send).toHaveBeenCalledWith('안녕', [])
    expect(promptValue(input)).toBe('안녕')
  })

  // Like any put-back, the refused message lands after what was composed meanwhile.
  it('keeps the draft when a rejected send races the next composition', async () => {
    const dispatch = deferred()
    const structured = transport({
      dispatchCommand: vi.fn(() => dispatch.promise),
      send: vi.fn(() => false)
    })
    renderComposer(structured)
    const input = textarea()

    changePrompt(input, '안녕')
    pressEnter(input)

    fireEvent.compositionStart(input)
    changePrompt(input, '안녕하')

    await act(async () => {
      dispatch.resolve(PASS_THROUGH)
      await dispatch.promise
    })
    fireEvent.compositionEnd(input, { data: '하' })

    expect(promptValue(input)).toBe('하\n\n안녕')
  })

  // A rejected command still reports its error, and the composer keeps the text to retry.
  it('keeps the draft when a handled command is rejected', async () => {
    const structured = transport({
      dispatchCommand: vi.fn(async () => ({ handled: true, accepted: false, error: 'nope' }))
    })
    renderComposer(structured)
    const input = textarea()

    changePrompt(input, '/model')
    await act(async () => pressEnter(input))

    expect(structured.onError).toHaveBeenCalledWith('nope')
    expect(structured.send).not.toHaveBeenCalled()
    expect(promptValue(input)).toBe('/model')
  })
})

describe('a withdrawn message put back during an IME composition', () => {
  // The field ignores a programmatic draft while the IME owns it, and the next composed keystroke
  // wrote the draft without the text, after its outbox entry had already been dropped.
  it('shows the text once the composition settles, after what was composed', () => {
    renderComposer(transport())
    const pane = draftKey
    const input = textarea()
    changePrompt(input, 'abc')

    fireEvent.compositionStart(input)
    changePrompt(input, 'abc안')
    act(() => void appendNativeChatDraftNow(pane, { text: 'withdrawn' }))
    changePrompt(input, 'abc안녕')
    fireEvent.compositionEnd(input, { data: '안녕' })

    expect(promptValue(input)).toBe('abc안녕\n\nwithdrawn')
    expect(readNativeChatDraftCache(pane)).toBe('abc안녕\n\nwithdrawn')
  })

  // Settling spends the held text; a later write or composition must not add it again.
  it('shows the text once, however much is typed or composed after', () => {
    renderComposer(transport())
    const pane = draftKey
    const input = textarea()
    changePrompt(input, 'abc')
    fireEvent.compositionStart(input)
    changePrompt(input, 'abc안')
    act(() => void appendNativeChatDraftNow(pane, { text: 'withdrawn' }))
    fireEvent.compositionEnd(input, { data: '안' })

    changePrompt(input, 'abc안\n\nwithdrawn!')
    fireEvent.compositionStart(input)
    changePrompt(input, 'abc안\n\nwithdrawn!가')
    fireEvent.compositionEnd(input, { data: '가' })

    expect(promptValue(input)).toBe('abc안\n\nwithdrawn!가')
    expect(readNativeChatDraftCache(pane)).toBe('abc안\n\nwithdrawn!가')
  })

  // The settle first swaps in the composed value (dropping the sent text), then adds the held text.
  it('keeps the text when a sent message is also cleared mid-composition', async () => {
    const dispatch = deferred()
    const structured = transport({ dispatchCommand: vi.fn(() => dispatch.promise) })
    renderComposer(structured)
    const pane = draftKey
    const input = textarea()
    changePrompt(input, '안녕')
    pressEnter(input)

    fireEvent.compositionStart(input)
    changePrompt(input, '안녕하')
    act(() => void appendNativeChatDraftNow(pane, { text: 'withdrawn' }))
    await act(async () => {
      dispatch.resolve(PASS_THROUGH)
      await dispatch.promise
    })
    fireEvent.compositionEnd(input, { data: '하' })

    expect(promptValue(input)).toBe('하\n\nwithdrawn')
    expect(readNativeChatDraftCache(pane)).toBe('하\n\nwithdrawn')
  })
})

// A crash before the host has the message must restore it unsent, and one after must not bring it
// back, so the box's clear is saved only once the host has it.
describe('the saved draft at send', () => {
  beforeEach(() => {
    clearNativeChatDraftCacheForTests()
    installLocalStorageNativeChatDrafts({ like: 'desktop' })
  })

  function savedRecord(): PersistedNativeChatDraft | null {
    const raw = localStorage.getItem(
      `orca:nativeChatComposerDraft:v1:${encodeURIComponent(draftKey)}`
    )
    return raw ? JSON.parse(raw) : null
  }

  function savedText(): string | null {
    return savedRecord()?.text ?? null
  }

  // The sent messages the saved draft still holds, beside its live text.
  function savedHeld(): string[] {
    return savedRecord()?.heldSends?.map((send) => send.text) ?? []
  }

  // The real outbox, so the test can play the host taking the message.
  function outboxTransport(): NativeChatStructuredComposerTransport {
    const structured = transport()
    structured.send = vi.fn(
      (text: string) =>
        appendStructuredAgentSessionOutboxMessage(structured.sessionId, text) !== null
    )
    return structured
  }

  // A settled refusal: the message stays for Retry under a new id.
  function hostRefusesWithNewId(
    structured: NativeChatStructuredComposerTransport,
    entry: ReturnType<typeof getStructuredAgentSessionOutbox>[number]
  ): void {
    act(() => {
      commitStructuredAgentSessionOutbox(structured.sessionId, [
        { ...entry, clientMessageId: 'rotated-id', state: 'rejected' }
      ])
    })
  }

  function hostTakes(structured: NativeChatStructuredComposerTransport): void {
    act(() => {
      commitStructuredAgentSessionOutbox(structured.sessionId, [])
    })
  }

  async function sendTyped(structured: NativeChatStructuredComposerTransport, text: string) {
    renderComposer(structured)
    const input = textarea()
    changePrompt(input, text)
    act(() => flushNativeChatDraftPersists())
    await act(async () => pressEnter(input))
    return input
  }

  it('keeps the message saved until the host has it, then saves the empty box', async () => {
    const structured = outboxTransport()
    const input = await sendTyped(structured, 'ship it')

    expect(structured.send).toHaveBeenCalledOnce()
    expect(promptValue(input)).toBe('')
    expect(savedText()).toBe('')
    expect(savedHeld()).toEqual(['ship it'])

    hostTakes(structured)
    await act(async () => {})
    expect(savedRecord()).toBeNull()
  })

  // "Sent" is the host's ok reply: a message it holds for the provider must not come back.
  it('saves the box once the host holds the message for good, while it waits for the provider', async () => {
    const structured = outboxTransport()
    await sendTyped(structured, 'mid-turn message')
    const [pending] = getStructuredAgentSessionOutbox(structured.sessionId)

    act(() =>
      noteStructuredAgentSessionMessagesDelivered(structured.sessionId, [pending.clientMessageId])
    )
    await act(async () => {})

    expect(getStructuredAgentSessionOutbox(structured.sessionId)).toHaveLength(1)
    expect(savedText()).toBeNull()
  })

  it('keeps a message the host refused, under its new id, until that one is delivered', async () => {
    const structured = outboxTransport()
    await sendTyped(structured, 'refused message')
    const [first] = getStructuredAgentSessionOutbox(structured.sessionId)

    hostRefusesWithNewId(structured, first)
    expect(savedRecord()?.heldSends).toMatchObject([
      { clientMessageId: 'rotated-id', text: 'refused message' }
    ])

    act(() => noteStructuredAgentSessionMessagesDelivered(structured.sessionId, ['rotated-id']))
    await act(async () => {})
    expect(savedRecord()).toBeNull()
  })

  it('releases a later send the host holds while an earlier one waits for Retry', async () => {
    const structured = outboxTransport()
    const input = await sendTyped(structured, 'message A')
    const [held] = getStructuredAgentSessionOutbox(structured.sessionId)
    act(() => {
      commitStructuredAgentSessionOutbox(structured.sessionId, [{ ...held, state: 'rejected' }])
    })

    changePrompt(input, 'message B')
    act(() => flushNativeChatDraftPersists())
    await act(async () => pressEnter(input))
    const later = getStructuredAgentSessionOutbox(structured.sessionId).filter(
      (entry) => entry.clientMessageId !== held.clientMessageId
    )
    act(() =>
      noteStructuredAgentSessionMessagesDelivered(
        structured.sessionId,
        later.map((entry) => entry.clientMessageId)
      )
    )
    await act(async () => {})

    expect(savedHeld()).toEqual(['message A'])
  })

  it('releases only the send the host holds while a later one still waits', async () => {
    const structured = outboxTransport()
    const input = await sendTyped(structured, 'message A')
    const [first] = getStructuredAgentSessionOutbox(structured.sessionId)
    changePrompt(input, 'message B')
    act(() => flushNativeChatDraftPersists())
    await act(async () => pressEnter(input))

    act(() =>
      noteStructuredAgentSessionMessagesDelivered(structured.sessionId, [first.clientMessageId])
    )
    await act(async () => {})

    expect(savedText()).toBe('')
    expect(savedHeld()).toEqual(['message B'])
  })

  // Case 12: a send while the agent works, then a normal quit. Until the agent accepted it, the host
  // may lose the message when Orca quits, so both copies stay: the outbox entry and the saved draft.
  it.each(['pagehide', 'beforeunload'])(
    'keeps the saved message and its outbox entry when the window goes away (%s)',
    async (event) => {
      const structured = outboxTransport()
      await sendTyped(structured, 'queued while working')
      expect(savedHeld()).toEqual(['queued while working'])

      act(() => window.dispatchEvent(new Event(event)))
      await act(async () => {})

      expect(savedHeld()).toEqual(['queued while working'])
      expect(getStructuredAgentSessionOutbox(structured.sessionId)).toHaveLength(1)
    }
  )

  // The whole clear a real send does: text, image chips and the editor. No write of the emptied
  // box may reach the store before the host has the message.
  it('writes nothing without the message until the host has it, with images attached', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        fs: {
          authorizeExternalPath: vi.fn(async () => {}),
          pathsExist: vi.fn(async () => [{ exists: true }])
        }
      }
    })
    const drafts = installLocalStorageNativeChatDrafts({ like: 'desktop' })
    const saves: (PersistedNativeChatDraft | null)[] = []
    installNativeChatDrafts({
      ...drafts,
      write: (scopeKey, draft) => {
        saves.push(draft)
        return drafts.write(scopeKey, draft)
      }
    })
    const holdsMessage = (draft: PersistedNativeChatDraft | null): boolean =>
      [draft, ...(draft?.heldSends ?? [])].some(
        (copy) => copy?.text === 'look at this' && copy.attachments.length === 1
      )
    const structured = outboxTransport()
    const chat = nativeChatDraftKey({ sessionId: structured.sessionId, paneKey: '' })
    act(
      () =>
        void appendNativeChatDraftNow(chat, {
          text: 'look at this',
          attachments: [{ id: 'shot', path: '/shot.png', location: 'local' }]
        })
    )
    renderComposer(structured)
    await act(async () => {})
    const input = textarea()
    saves.length = 0

    await act(async () => pressEnter(input))
    await act(async () => {})

    expect(structured.send).toHaveBeenCalledOnce()
    expect(promptValue(input)).toBe('')
    expect(saves.filter((save) => !holdsMessage(save))).toEqual([])
    expect(savedHeld()).toEqual(['look at this'])

    hostTakes(structured)
    await act(async () => {})
    expect(saves.at(-1)).toBeNull()
  })

  // A crash can never find the box saved empty without the message it sent.
  it('saves the emptied box and the sent message, under its id, in one write', async () => {
    const drafts = installLocalStorageNativeChatDrafts({ like: 'desktop' })
    const saves: (PersistedNativeChatDraft | null)[] = []
    installNativeChatDrafts({
      ...drafts,
      write: (scopeKey, draft) => {
        saves.push(draft)
        return drafts.write(scopeKey, draft)
      }
    })
    const structured = outboxTransport()
    renderComposer(structured)
    const input = textarea()
    changePrompt(input, 'ship it')
    act(() => flushNativeChatDraftPersists())
    saves.length = 0

    await act(async () => pressEnter(input))
    await act(async () => {})
    const [entry] = getStructuredAgentSessionOutbox(structured.sessionId)

    expect(saves).toEqual([
      {
        text: '',
        attachments: [],
        heldSends: [
          {
            clientMessageId: entry.clientMessageId,
            text: 'ship it',
            attachments: [],
            sentAt: expect.any(Number)
          }
        ]
      }
    ])
  })

  it('keeps what was typed after Enter when the host takes the message', async () => {
    const structured = outboxTransport()
    const input = await sendTyped(structured, 'ship it')

    changePrompt(input, 'and then')
    hostTakes(structured)
    await act(async () => {})

    expect(savedText()).toBe('and then')
  })

  // Browser storage reaches disk lazily anyway; clearing first frees the quota the outbox append
  // shares with drafts, so a large draft cannot make that append, and the send, fail.
  it('saves the clear at Enter in the web client, before the outbox takes the message', async () => {
    installLocalStorageNativeChatDrafts()
    const seenBySend: (string | null)[] = []
    const structured = transport()
    structured.send = vi.fn((text: string) => {
      seenBySend.push(savedText())
      return appendStructuredAgentSessionOutboxMessage(structured.sessionId, text) !== null
    })
    const input = await sendTyped(structured, 'a long message')

    expect(seenBySend).toEqual([null])
    expect(promptValue(input)).toBe('')
  })

  it('leaves the saved message alone, and puts it back in the box, when the send is refused', async () => {
    const drafts = installLocalStorageNativeChatDrafts({ like: 'desktop' })
    const saves: (string | null)[] = []
    installNativeChatDrafts({
      ...drafts,
      write: (scopeKey, draft) => {
        saves.push(draft?.text ?? null)
        return drafts.write(scopeKey, draft)
      }
    })
    const structured = transport({ send: vi.fn(() => false) })
    const input = await sendTyped(structured, 'ship it')

    expect(promptValue(input)).toBe('ship it')
    expect(savedText()).toBe('ship it')
    expect(saves).not.toContain(null)
  })
})

describe('the draft saved to disk', () => {
  beforeEach(() => clearNativeChatDraftCacheForTests())

  // A clear left to the typing delay would let a crash right after Enter bring the sent text back.
  it('is removed the moment the send is accepted', async () => {
    renderComposer(transport())
    const key = `orca:nativeChatComposerDraft:v1:${encodeURIComponent(draftKey)}`
    const input = textarea()
    changePrompt(input, 'ship it')
    act(() => window.dispatchEvent(new Event('pagehide')))
    expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toMatchObject({ text: 'ship it' })

    await act(async () => pressEnter(input))

    expect(localStorage.getItem(key)).toBeNull()
  })

  // Sending would hand the agent a path to nothing; the chip says so and Send waits for its removal.
  it('will not send a restored image whose file is gone until the chip is removed', async () => {
    const structured = transport()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        fs: { pathsExist: vi.fn(async () => [{ exists: false }]) }
      }
    })
    const chat = nativeChatDraftKey({ sessionId: structured.sessionId, paneKey: '' })
    appendNativeChatDraftNow(chat, {
      text: 'look at this',
      attachments: [{ id: 'gone', path: '/gone.png', location: 'local' }]
    })
    renderComposer(structured)
    await act(async () => {})

    await act(async () => pressEnter(textarea()))
    expect(structured.send).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: /Image no longer available\. Remove it to send\./ })
    ).toBeTruthy()
    // The reason Send is held is shown without hovering the chip.
    expect(screen.getByText('Image no longer available. Remove it to send.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }))
    expect(screen.queryByText('Image no longer available. Remove it to send.')).toBeNull()
    await act(async () => pressEnter(textarea()))
    expect(structured.send).toHaveBeenCalledWith('look at this', [])
  })

  // The composing box still holds the sent text; its keystrokes must not save it again before the
  // composition settles, or a crash meanwhile restores it and the next Enter sends it twice.
  it('never gets the sent text back from a composition the clear landed in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const dispatch = deferred()
      renderComposer(transport({ dispatchCommand: vi.fn(() => dispatch.promise) }))
      const key = `orca:nativeChatComposerDraft:v1:${encodeURIComponent(draftKey)}`
      const input = textarea()
      changePrompt(input, '안녕')
      pressEnter(input)
      fireEvent.compositionStart(input)
      changePrompt(input, '안녕하')
      await act(async () => {
        dispatch.resolve(PASS_THROUGH)
        await dispatch.promise
      })

      changePrompt(input, '안녕하나')
      act(() => vi.advanceTimersByTime(1000))

      expect(readNativeChatDraftCache(draftKey)).toBe('')
      expect(localStorage.getItem(key)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a put-back but not the sent text when both land mid-composition', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const dispatch = deferred()
      renderComposer(transport({ dispatchCommand: vi.fn(() => dispatch.promise) }))
      const pane = draftKey
      const key = `orca:nativeChatComposerDraft:v1:${encodeURIComponent(pane)}`
      const input = textarea()
      changePrompt(input, '안녕')
      pressEnter(input)
      fireEvent.compositionStart(input)
      changePrompt(input, '안녕하')
      act(() => void appendNativeChatDraftNow(pane, { text: 'withdrawn' }))
      await act(async () => {
        dispatch.resolve(PASS_THROUGH)
        await dispatch.promise
      })

      changePrompt(input, '안녕하나')
      act(() => vi.advanceTimersByTime(1000))

      expect(readNativeChatDraftCache(pane)).toBe('withdrawn')
      expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toMatchObject({ text: 'withdrawn' })
      fireEvent.compositionEnd(input, { data: '하나' })
      expect(readNativeChatDraftCache(pane)).toBe('하나\n\nwithdrawn')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('one chat shown in two panes', () => {
  beforeEach(() => clearNativeChatDraftCacheForTests())

  function renderTwoPanes(): {
    first: HTMLElement
    second: HTMLElement
    structured: NativeChatStructuredComposerTransport
  } {
    const structured = transport()
    paneCounter += 1
    const panes = [`tab-${paneCounter}:first`, `tab-${paneCounter}:second`]
    draftKey = nativeChatDraftKey({ sessionId: structured.sessionId, paneKey: panes[0] })
    render(
      <>
        {panes.map((paneKey) => (
          <NativeChatComposer
            key={paneKey}
            terminalTabId={`tab-${paneCounter}`}
            paneKey={paneKey}
            targetPtyId={null}
            agent="codex"
            structuredTransport={structured}
          />
        ))}
      </>
    )
    const [first, second] = screen.getAllByRole('textbox')
    return { first, second, structured }
  }

  it('shows typing from either pane in the other, losing no keystrokes', () => {
    const { first, second } = renderTwoPanes()

    changePrompt(first, 'hello')
    expect(promptValue(second)).toBe('hello')
    changePrompt(second, 'hello world')
    expect(promptValue(first)).toBe('hello world')
    changePrompt(first, 'hello world!')

    expect(promptValue(second)).toBe('hello world!')
    expect(readNativeChatDraftCache(draftKey)).toBe('hello world!')
  })

  it('empties every pane when one sends', async () => {
    const { first, second, structured } = renderTwoPanes()
    changePrompt(first, 'ship it')

    await act(async () => pressEnter(second))

    expect(structured.send).toHaveBeenCalledWith('ship it', [])
    expect(promptValue(first)).toBe('')
    expect(promptValue(second)).toBe('')
  })

  it('shows text put back by a Stop in every pane', () => {
    const { first, second } = renderTwoPanes()

    act(() => void appendNativeChatDraftNow(draftKey, { text: 'withdrawn' }))

    expect(promptValue(first)).toBe('withdrawn')
    expect(promptValue(second)).toBe('withdrawn')
  })

  // The live composition owns its field, as against every programmatic draft: the other pane's
  // text must neither break the composition nor be written over it until it settles.
  it('leaves a composition intact when the other pane writes mid-composition', () => {
    const { first, second } = renderTwoPanes()
    changePrompt(second, 'abc')

    fireEvent.compositionStart(second)
    changePrompt(second, 'abc안')
    changePrompt(first, 'from the other pane')
    expect(promptValue(second)).toBe('abc안')
    changePrompt(second, 'abc안녕')
    fireEvent.compositionEnd(second, { data: '안녕' })

    expect(promptValue(second)).toBe('abc안녕')
    expect(promptValue(first)).toBe('abc안녕')
    expect(readNativeChatDraftCache(draftKey)).toBe('abc안녕')
  })

  it('keeps the settled composition when the other pane wrote after its last keystroke', () => {
    const { first, second } = renderTwoPanes()
    changePrompt(second, 'abc')

    fireEvent.compositionStart(second)
    changePrompt(second, 'abc안')
    changePrompt(first, 'from the other pane')
    fireEvent.compositionEnd(second, { data: '안' })

    expect(promptValue(second)).toBe('abc안')
    expect(promptValue(first)).toBe('abc안')
    expect(readNativeChatDraftCache(draftKey)).toBe('abc안')
  })

  it('keeps only the composed segment when the other pane sends mid-composition', async () => {
    const { first, second } = renderTwoPanes()
    changePrompt(first, 'sent')

    fireEvent.compositionStart(second)
    await act(async () => pressEnter(first))
    changePrompt(second, 'sent하')
    fireEvent.compositionEnd(second, { data: '하' })

    expect(promptValue(second)).toBe('하')
    expect(promptValue(first)).toBe('하')
    expect(readNativeChatDraftCache(draftKey)).toBe('하')
  })

  it('never shows the sent text again in the sending pane while the other pane composes', async () => {
    const { first, second } = renderTwoPanes()
    changePrompt(first, 'sent')

    fireEvent.compositionStart(second)
    await act(async () => pressEnter(first))
    changePrompt(second, 'sent하')

    expect(promptValue(first)).toBe('')
    expect(readNativeChatDraftCache(draftKey)).toBe('')
  })
})
