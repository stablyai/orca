import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { endComposition } from '@/lib/text-input/ime/ime-composition-event.test-support'
import { changePrompt, promptValue } from '../editor/native-chat-prompt-editor.test-support'
// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as nativeChatAgentProfiles from '../../../../../../shared/native-chat/native-chat-agent-profiles'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import type * as RemoteRuntimePtyIdModule from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

vi.mock('../controls/NativeChatComposerWorkspace', () => ({
  NativeChatComposerWorkspace: () => null
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
const actions = vi.hoisted((): { sendDisabled: boolean | null } => ({ sendDisabled: null }))

vi.mock('../controls/NativeChatComposerActions', () => ({
  NativeChatComposerActions: (props: { sendDisabled: boolean }) => {
    actions.sendDisabled = props.sendDisabled
    return <div data-testid="composer-actions" />
  }
}))
vi.mock('../pickers/NativeChatAutocompleteMenus', () => ({
  NativeChatMentionMenu: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('../../../../store/index', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-input-send', () => ({
  sendRuntimePtyInput: vi.fn()
}))
vi.mock(
  '../../../../../../shared/remote-runtime/remote-runtime-pty-id',
  async (importOriginal) => ({
    ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
    isRemoteRuntimePtyId: () => false
  })
)
vi.mock('../../session/terminal/send/native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('../../session/terminal/send/native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn()
}))
vi.mock('../../session/options/terminal/claude-model-switch-confirmation', () => ({
  createClaudeModelSwitchConfirmationObserver: vi.fn()
}))
vi.mock(
  '../../../../../../shared/native-chat/native-chat-agent-profiles',
  async (importOriginal) => ({
    ...(await importOriginal<typeof nativeChatAgentProfiles>()),
    getVerifiedNativeChatCommands: () => []
  })
)
vi.mock('../../telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('../pickers/use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('../../../dictation/dictation-control-events', () => ({
  dispatchDictationControl: vi.fn()
}))

import { NativeChatComposer } from '../NativeChatComposer'
import {
  appendNativeChatDraftCache,
  readNativeChatDraftCache
} from '../../drafts/native-chat-draft-views'

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
    capturePresentation: () => () => true,
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
    sessionId: 'session-test',
    runtimeEnvironmentId: null,
    ...overrides
  }
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

function pressEnter(input: HTMLTextAreaElement): void {
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false })
}

let paneCounter = 0

function renderComposer(structuredTransport: NativeChatStructuredComposerTransport) {
  paneCounter += 1
  return render(
    <NativeChatComposer
      terminalTabId={`tab-${paneCounter}`}
      paneKey={`tab-${paneCounter}:structured`}
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
      pty: { getMainBufferSnapshot: vi.fn().mockResolvedValue(null) }
    }
  })
})

afterEach(() => cleanup())

describe('structured send racing the next IME composition', () => {
  // Replay accepted clears after the next IME composition; otherwise settlement can restore sent text (#17359).
  it('preserves the next composition when a typed goal is accepted', async () => {
    const dispatch = deferred()
    const structured = transport({
      dispatchCommand: vi.fn(async () => PASS_THROUGH).mockReturnValueOnce(dispatch.promise),
      threadGoal: { setObjective: vi.fn() }
    })
    renderComposer(structured)
    const pane = `tab-${paneCounter}:structured`
    const input = textarea()

    changePrompt(input, '/goal 안녕')
    pressEnter(input)
    expect(structured.dispatchCommand).toHaveBeenCalledWith('/goal 안녕', expect.any(Function))

    fireEvent.compositionStart(input)
    changePrompt(input, '/goal 안녕하')

    await act(async () => {
      dispatch.resolve({ handled: true, accepted: true, error: null })
      await dispatch.promise
    })
    expect(promptValue(input)).toBe('/goal 안녕하')
    expect(structured.send).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input, { data: '하' })

    expect(promptValue(input)).toBe('하')
    expect(readNativeChatDraftCache(pane)).toBe('하')

    await act(async () => pressEnter(input))
    expect(structured.send).toHaveBeenLastCalledWith('하', [])
  })
})

describe('a withdrawn message put back during an IME composition', () => {
  // At settlement clear sent text before appending held returned text.
  it('keeps the text when a sent message is also cleared mid-composition', async () => {
    const dispatch = deferred()
    const structured = transport({ dispatchCommand: vi.fn(() => dispatch.promise) })
    renderComposer(structured)
    const pane = `tab-${paneCounter}:structured`
    const input = textarea()
    changePrompt(input, '안녕')
    pressEnter(input)

    fireEvent.compositionStart(input)
    changePrompt(input, '안녕하')
    act(() => appendNativeChatDraftCache(pane, 'withdrawn'))
    await act(async () => {
      dispatch.resolve(PASS_THROUGH)
      await dispatch.promise
    })
    fireEvent.compositionEnd(input, { data: '하' })

    expect(promptValue(input)).toBe('하\n\nwithdrawn')
    expect(readNativeChatDraftCache(pane)).toBe('하\n\nwithdrawn')
  })
})

// Regression (#30159): a message ending in a composing syllable needed a second Enter.
describe('the Enter that commits a Hangul composition', () => {
  it('sends the message once, with its last syllable', async () => {
    const structured = transport()
    renderComposer(structured)
    const input = textarea()

    fireEvent.compositionStart(input)
    changePrompt(input, '안녕하세요')
    fireEvent.keyDown(input, { key: 'Process', keyCode: 229, isComposing: true })
    endComposition(input, '요')
    await act(async () => pressEnter(input))

    expect(structured.send).toHaveBeenCalledOnce()
    expect(structured.send).toHaveBeenCalledWith('안녕하세요', [])
  })
})
