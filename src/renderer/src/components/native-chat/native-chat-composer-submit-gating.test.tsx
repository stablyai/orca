// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClaudeSubmitBytesCacheForTests } from './native-chat-claude-submit-cache'

// Exercises the real composer + real submit-gesture pipeline (cache + hooks are
// NOT mocked); only the IPC keybindings read and the leaf sends are controlled.
const mocks = vi.hoisted(() => ({
  fieldProps: null as { onSend?: () => void; sendButtonDisabled?: boolean } | null,
  draft: 'hello',
  imageAttachments: [] as { id: string; path: string; pending?: boolean }[],
  sendNativeChatMessage: vi.fn(),
  sendNativeChatMessageWithImageAttachments: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  trackPendingSend: vi.fn(),
  cancelPendingSends: vi.fn(),
  readClaudeKeybindings: vi.fn(),
  sendHandle: { cancel: vi.fn(), settleAfterMs: 0 }
}))

vi.mock('../../store', () => {
  const state = {
    settings: { nativeChatSessionOptions: {} },
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn()
  }
  const useAppStore = (selector: (v: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false,
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({ getSettingsForAgentTabRuntimeOwner: () => ({}) }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...a: unknown[]) => mocks.sendNativeChatMessage(...a),
  sendNativeChatTypedCommand: (...a: unknown[]) => mocks.sendNativeChatTypedCommand(...a),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: (...a: unknown[]) =>
    mocks.sendNativeChatMessageWithImageAttachments(...a)
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('./use-native-chat-draft', () => ({
  useNativeChatDraft: () => ({ draft: mocks.draft, setDraft: vi.fn() })
}))
vi.mock('./native-chat-draft-cache', () => ({ readNativeChatDraftCache: () => '' }))
vi.mock('./NativeChatComposerField', () => ({
  NativeChatComposerField: (props: { onSend?: () => void; sendButtonDisabled?: boolean }) => {
    mocks.fieldProps = props
    return <div data-testid="field" />
  }
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('./use-native-chat-composer-attachments', () => ({
  useNativeChatComposerAttachments: () => ({
    imageAttachments: mocks.imageAttachments,
    attachResolvedPaths: vi.fn(),
    clearImageAttachments: vi.fn(),
    flushPendingAttachments: vi.fn(),
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

const remap = JSON.stringify({
  bindings: [{ context: 'Chat', bindings: { enter: 'chat:newline', 'alt+enter': 'chat:submit' } }]
})

describe('NativeChatComposer submit-gesture gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetClaudeSubmitBytesCacheForTests()
    mocks.fieldProps = null
    mocks.draft = 'hello'
    mocks.imageAttachments = []
    mocks.sendNativeChatMessage.mockReturnValue(mocks.sendHandle)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        nativeChat: { readClaudeKeybindings: mocks.readClaudeKeybindings },
        ui: { onFileDrop: () => vi.fn() },
        pty: { getMainBufferSnapshot: vi.fn().mockResolvedValue(null) }
      }
    })
  })
  afterEach(() => {
    cleanup()
    resetClaudeSubmitBytesCacheForTests()
  })

  it('holds Send until the Claude keybinding read resolves, then submits', async () => {
    let resolveRead: (value: string) => void = () => {}
    mocks.readClaudeKeybindings.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRead = resolve
      })
    )
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="claude"
      />
    )

    // Still reading: Send disabled and a triggered send is a no-op.
    expect(mocks.fieldProps?.sendButtonDisabled).toBe(true)
    act(() => mocks.fieldProps?.onSend?.())
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()

    await act(async () => {
      resolveRead(remap)
    })

    // Resolved: Send enables and now submits (with the resolved Alt+Enter gesture).
    await waitFor(() => expect(mocks.fieldProps?.sendButtonDisabled).toBe(false))
    act(() => mocks.fieldProps?.onSend?.())
    expect(mocks.sendNativeChatMessage).toHaveBeenCalledWith(
      {},
      'pty-1',
      'hello',
      expect.objectContaining({ submitBytes: '\x1b\r' })
    )
  })

  it('does not gate a Codex pane (no keybinding read)', () => {
    mocks.readClaudeKeybindings.mockReturnValue(new Promise<string>(() => {}))
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
      />
    )
    expect(mocks.fieldProps?.sendButtonDisabled).toBe(false)
    expect(mocks.readClaudeKeybindings).not.toHaveBeenCalled()
  })
})
