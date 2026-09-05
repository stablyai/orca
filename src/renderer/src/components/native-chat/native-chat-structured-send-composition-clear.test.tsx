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

function renderComposer(structuredTransport: NativeChatStructuredComposerTransport): void {
  paneCounter += 1
  render(
    <NativeChatComposer
      terminalTabId={`tab-${paneCounter}`}
      paneKey={`tab-${paneCounter}:structured`}
      targetPtyId={null}
      agent="codex"
      structuredTransport={structuredTransport}
    />
  )
}

describe('structured send racing the next IME composition', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        git: { discoverCommitMessageModels: vi.fn().mockResolvedValue({ success: false }) },
        pty: { getMainBufferSnapshot: vi.fn().mockResolvedValue(null) },
        ui: { onFileDrop: () => vi.fn() }
      }
    })
  })

  afterEach(() => cleanup())

  // The regression: the RPC's clear lands while the NEXT composition is live, so the DOM sync
  // drops it and settlement used to adopt the sent text back into the composer (#17359).
  it('does not resurrect the sent message when the clear lands mid-composition', async () => {
    const dispatch = deferred()
    const structured = transport({ dispatchCommand: vi.fn(() => dispatch.promise) })
    renderComposer(structured)
    const input = textarea()

    fireEvent.change(input, { target: { value: '안녕' } })
    pressEnter(input)
    expect(structured.dispatchCommand).toHaveBeenCalledWith('안녕')

    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '안녕하' } })

    await act(async () => {
      dispatch.resolve(PASS_THROUGH)
      await dispatch.promise
    })
    fireEvent.compositionEnd(input, { data: '하' })

    expect(input.value).toBe('하')

    await act(async () => pressEnter(input))
    expect(structured.send).toHaveBeenLastCalledWith('하', [])
  })

  it('keeps the composed text when a mid-composition clear lands away from the caret', async () => {
    const dispatch = deferred()
    const structured = transport({ dispatchCommand: vi.fn(() => dispatch.promise) })
    renderComposer(structured)
    const input = textarea()

    fireEvent.change(input, { target: { value: 'abcd' } })
    pressEnter(input)

    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: 'ab가cd' } })

    await act(async () => {
      dispatch.resolve(PASS_THROUGH)
      await dispatch.promise
    })
    fireEvent.compositionEnd(input, { data: '가' })

    expect(input.value).toBe('가')
  })

  // Clearing optimistically before the RPC would lose the draft here, which is why the clear
  // stays on the acceptance path and is instead replayed at settlement.
  it('keeps the draft when the send is rejected', async () => {
    const structured = transport({ send: vi.fn(() => false) })
    renderComposer(structured)
    const input = textarea()

    fireEvent.change(input, { target: { value: '안녕' } })
    await act(async () => pressEnter(input))

    expect(structured.send).toHaveBeenCalledWith('안녕', [])
    expect(input.value).toBe('안녕')
  })

  it('keeps the draft when a rejected send races the next composition', async () => {
    const dispatch = deferred()
    const structured = transport({
      dispatchCommand: vi.fn(() => dispatch.promise),
      send: vi.fn(() => false)
    })
    renderComposer(structured)
    const input = textarea()

    fireEvent.change(input, { target: { value: '안녕' } })
    pressEnter(input)

    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '안녕하' } })

    await act(async () => {
      dispatch.resolve(PASS_THROUGH)
      await dispatch.promise
    })
    fireEvent.compositionEnd(input, { data: '하' })

    expect(input.value).toBe('안녕하')
  })

  // A rejected command still reports its error, and the composer keeps the text to retry.
  it('keeps the draft when a handled command is rejected', async () => {
    const structured = transport({
      dispatchCommand: vi.fn(async () => ({ handled: true, accepted: false, error: 'nope' }))
    })
    renderComposer(structured)
    const input = textarea()

    fireEvent.change(input, { target: { value: '/model' } })
    await act(async () => pressEnter(input))

    expect(structured.onError).toHaveBeenCalledWith('nope')
    expect(structured.send).not.toHaveBeenCalled()
    expect(input.value).toBe('/model')
  })
})
