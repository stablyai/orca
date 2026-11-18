// @vitest-environment happy-dom

import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as nativeChatAgentProfiles from '../../../../shared/native-chat/input/commands/native-chat-agent-profiles'
import type * as RemoteRuntimePtyIdModule from '../../../../shared/remote-runtime/remote-runtime-pty-id'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('./composer/controls/NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => <div data-testid="composer-actions" />
}))
vi.mock('./composer/pickers/NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('../../store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    agentStatusByPaneKey: acceptedAgentStatuses(),
    structuredSessionLaunchDirectoryByTabId: {},
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('../../../../shared/remote-runtime/remote-runtime-pty-id', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
  isRemoteRuntimePtyId: () => false
}))
vi.mock('./session/terminal/send/native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./session/terminal/send/native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn()
}))
vi.mock('./session/options/terminal/claude-model-switch-confirmation', () => ({
  createClaudeModelSwitchConfirmationObserver: vi.fn()
}))
vi.mock(
  '../../../../shared/native-chat/input/commands/native-chat-agent-profiles',
  async (importOriginal) => ({
    ...(await importOriginal<typeof nativeChatAgentProfiles>()),
    getVerifiedNativeChatCommands: () => []
  })
)
vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('./composer/pickers/use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('../dictation/dictation-control-events', () => ({
  dispatchDictationControl: vi.fn()
}))

import { NativeChatComposer } from './composer/NativeChatComposer'
import type { NativeChatComposerHandle } from './composer/native-chat-composer-types'
import { changePrompt } from './composer/editor/native-chat-prompt-editor.test-support'
import { NATIVE_CHAT_COMPOSER_GLOW_MS } from './native-chat-composer-glow'

const GLOW = 'native-chat-composer-glow'

/** The real composer and its handle, as a chat pane holds them. */
function renderComposer(): { composer: NativeChatComposerHandle; box: () => Element | null } {
  const ref = createRef<NativeChatComposerHandle>()
  render(
    <NativeChatComposer
      ref={ref}
      terminalTabId="tab-glow"
      paneKey="tab-glow:leaf"
      targetPtyId={null}
      agent="codex"
      structuredTransport={{
        capturePresentation: () => () => true,
        send: vi.fn(() => true),
        dispatchCommand: vi.fn(async () => ({ handled: false, accepted: false, error: null })),
        optionsSurface: {
          getSnapshot: () => [],
          setOption: vi.fn(),
          invokeAction: vi.fn(),
          subscribe: () => () => {}
        },
        optionSnapshot: [],
        onError: vi.fn(),
        runtime: 'local',
        sessionId: 'session-glow',
        runtimeEnvironmentId: null
      }}
    />
  )
  return { composer: ref.current!, box: () => document.querySelector(`.${GLOW}`) }
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

describe('composer glow for handed-in text', () => {
  it('flashes once for text handed in to finish, and ends on its own timer', () => {
    const { composer, box } = renderComposer()
    vi.useFakeTimers({ toFake: ['setTimeout', 'requestAnimationFrame'] })
    try {
      act(() => composer.appendText('Set up an automation that ', { glow: true }))
      expect(box()?.contains(screen.getByRole('textbox'))).toBe(true)
      // No animationend: a hidden or reduced-motion box still loses it, so no later reveal replays it.
      act(() => vi.advanceTimersByTime(NATIVE_CHAT_COMPOSER_GLOW_MS))
      expect(box()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts for text handed in again mid-flash, and the first flash cannot end the second', () => {
    const { composer, box } = renderComposer()
    vi.useFakeTimers({ toFake: ['setTimeout', 'requestAnimationFrame'] })
    try {
      act(() => composer.appendText('Set up an automation that ', { glow: true }))
      act(() => vi.advanceTimersByTime(NATIVE_CHAT_COMPOSER_GLOW_MS - 100))
      act(() => composer.appendText('Set up an automation that ', { glow: true }))
      expect(box()).toBeNull()
      act(() => {
        vi.advanceTimersToNextFrame()
        vi.advanceTimersToNextFrame()
      })
      expect(box()).not.toBeNull()
      act(() => vi.advanceTimersByTime(200))
      expect(box()).not.toBeNull()
      act(() => vi.advanceTimersByTime(NATIVE_CHAT_COMPOSER_GLOW_MS))
      expect(box()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays still for plain focus, a plain append and typing', () => {
    const { composer, box } = renderComposer()
    act(() => {
      composer.focus()
      composer.appendText('> quote')
    })
    changePrompt(screen.getByRole('textbox'), 'typed')
    expect(box()).toBeNull()
  })
})
