// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cancelPendingSends: vi.fn(),
  fieldProps: null as { onSend?: () => void; onStop?: () => void } | null,
  sendHandle: { cancel: vi.fn(), settleAfterMs: 500 },
  sendNativeChatMessage: vi.fn(),
  trackPendingSend: vi.fn(),
  setDraft: vi.fn()
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ dictationState: 'idle', settings: { voice: { enabled: false } } })
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false,
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: () => ({})
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args),
  sendNativeChatMessageWithImageAttachments: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-agent-commands', () => ({ getAgentSlashCommands: () => [] }))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('./use-native-chat-draft', () => ({
  useNativeChatDraft: () => ({ draft: 'hello', setDraft: mocks.setDraft })
}))
vi.mock('./native-chat-draft-cache', () => ({ readNativeChatDraftCache: () => '' }))
vi.mock('./NativeChatComposerField', () => ({
  NativeChatComposerField: (props: { onSend?: () => void; onStop?: () => void }) => {
    mocks.fieldProps = props
    return null
  }
}))
vi.mock('./use-native-chat-skills', () => ({ useNativeChatSkills: () => [] }))
vi.mock('./use-native-chat-composer-attachments', () => ({
  useNativeChatComposerAttachments: () => ({
    imageAttachments: [],
    attachResolvedPaths: vi.fn(),
    clearImageAttachments: vi.fn(),
    removeImageAttachment: vi.fn()
  })
}))
vi.mock('./use-native-chat-composer-paste', () => ({
  useNativeChatComposerPaste: () => ({ handlePaste: vi.fn(), pasteFromClipboard: vi.fn() })
}))
vi.mock('./use-native-chat-external-attachments', () => ({
  useNativeChatExternalAttachments: () => ({
    attachExternalPaths: vi.fn(),
    resolveAttachmentOwner: vi.fn()
  })
}))
vi.mock('../dictation/dictation-control-events', () => ({ dispatchDictationControl: vi.fn() }))
vi.mock('./use-native-chat-composer-keydown', () => ({
  useNativeChatComposerKeyDown: () => vi.fn()
}))
vi.mock('./use-native-chat-send-lifecycle', () => ({
  useNativeChatSendLifecycle: () => ({
    cancelPendingSends: mocks.cancelPendingSends,
    trackPendingSend: mocks.trackPendingSend
  })
}))

import { NativeChatComposer } from './NativeChatComposer'

describe('NativeChatComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fieldProps = null
    mocks.sendNativeChatMessage.mockReturnValue(mocks.sendHandle)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { onFileDrop: () => vi.fn() } }
    })
  })

  afterEach(() => cleanup())

  it('cancels delayed composer writes before the Stop button interrupts the agent', () => {
    const onStop = vi.fn()
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        targetPtyId="pty-1"
        agent="codex"
        isWorking
        onStop={onStop}
      />
    )

    act(() => mocks.fieldProps?.onStop?.())

    expect(mocks.cancelPendingSends).toHaveBeenCalledOnce()
    expect(onStop).toHaveBeenCalledOnce()
    expect(mocks.cancelPendingSends.mock.invocationCallOrder[0]).toBeLessThan(
      onStop.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('associates a delayed submit with its optimistic cache entry', () => {
    const onOptimisticSend = vi.fn(() => 'pending-1')
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        targetPtyId="pty-1"
        agent="codex"
        onOptimisticSend={onOptimisticSend}
      />
    )

    act(() => mocks.fieldProps?.onSend?.())

    expect(onOptimisticSend).toHaveBeenCalledWith('hello', [])
    expect(mocks.trackPendingSend).toHaveBeenCalledWith(mocks.sendHandle, 'pending-1')
  })
})
