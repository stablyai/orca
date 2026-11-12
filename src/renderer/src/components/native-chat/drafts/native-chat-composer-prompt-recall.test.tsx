import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { promptValue } from '../composer/editor/native-chat-prompt-editor.test-support'
// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type * as nativeChatAgentProfiles from '../../../../../shared/native-chat/native-chat-agent-profiles'
import type * as RemoteRuntimePtyIdModule from '../../../../../shared/remote-runtime/remote-runtime-pty-id'

vi.mock('../composer/controls/NativeChatComposerWorkspace', () => ({
  NativeChatComposerWorkspace: () => null
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('../composer/controls/NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => <div data-testid="composer-actions" />
}))
vi.mock('../composer/pickers/NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('../../../store/index', () => {
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
vi.mock('../../../../../shared/remote-runtime/remote-runtime-pty-id', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
  isRemoteRuntimePtyId: () => false
}))
vi.mock('../session/terminal/send/native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('../session/terminal/send/native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn()
}))
vi.mock('../session/options/terminal/claude-model-switch-confirmation', () => ({
  createClaudeModelSwitchConfirmationObserver: vi.fn()
}))
vi.mock('../../../../../shared/native-chat/native-chat-agent-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof nativeChatAgentProfiles>()),
  getVerifiedNativeChatCommands: () => []
}))
vi.mock('../telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('../composer/pickers/use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('../../dictation/dictation-control-events', () => ({
  dispatchDictationControl: vi.fn()
}))

import { NativeChatComposer } from '../composer/NativeChatComposer'

const sent = (id: string, text: string): NativeChatMessage => ({
  id,
  role: 'user',
  blocks: [{ type: 'text', text }],
  timestamp: null,
  source: 'transcript'
})

let paneCounter = 0

/** The real composer, editor and draft store over a chat that already holds `prompts`. */
function renderComposer(prompts: string[]): HTMLElement {
  paneCounter += 1
  render(
    <NativeChatComposer
      terminalTabId={`tab-${paneCounter}`}
      paneKey={`tab-${paneCounter}:recall`}
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
        sessionId: `session-${paneCounter}`,
        runtimeEnvironmentId: null
      }}
      recallSource={{ messages: prompts.map((text, index) => sent(`sent-${index}`, text)) }}
    />
  )
  return screen.getByRole('textbox')
}

function press(input: HTMLElement, key: 'ArrowUp' | 'ArrowDown'): string {
  fireEvent.keyDown(input, { key })
  return promptValue(input)
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

describe('composer prompt recall', () => {
  // `/model` opens the command picker when typed; recalled, it must not take the arrows.
  it('keeps walking past a recalled command instead of handing the arrows to its picker', () => {
    const input = renderComposer(['one', '/model'])
    expect(press(input, 'ArrowUp')).toBe('/model')
    expect(press(input, 'ArrowUp')).toBe('one')
  })
})
