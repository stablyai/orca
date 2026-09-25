// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import { clearNativeChatSessionOptionCacheForTests } from './native-chat-session-option-cache'
import { clearNativeChatModelEnrichmentForTests } from './native-chat-session-option-enrichment'

const mocks = vi.hoisted(() => ({
  cancelPendingSends: vi.fn(),
  composerIsComposing: null as (() => boolean) | null,
  attachmentIsComposing: null as (() => boolean) | null,
  flushPendingAttachments: vi.fn(),
  fieldProps: null as {
    onSend?: () => void
    onStop?: () => void
    imeEnterGesture?: {
      isComposing: () => boolean
      setComposing: (active: boolean) => void
    }
    onImeSettled?: (element: HTMLTextAreaElement) => void
    sessionOptionsSurface?: SessionOptionsSurface | null
    sessionOptionsSnapshot?: SessionOptionDescriptor[]
    attachDisabled?: boolean
    sendButtonDisabled?: boolean
    autocomplete?: { mode: string; items?: { kind: string; name: string }[] }
  } | null,
  modelSwitchOutcome: 'applied' as 'applied' | 'rejected' | 'unknown',
  confirmationObserver: null as {
    ready: Promise<void>
    result: Promise<'applied' | 'rejected' | 'unknown'>
    arm: ReturnType<typeof vi.fn>
    startDetection: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  } | null,
  createClaudeModelSwitchConfirmationObserver: vi.fn(),
  discoverCommitMessageModels: vi.fn(),
  draft: 'hello',
  imageAttachments: [] as { id: string; path: string; pending?: boolean }[],
  getMainBufferSnapshot: vi.fn(),
  sendHandle: {
    cancel: vi.fn(),
    settleAfterMs: 500,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the composer stub only needs the accepted promise slot this test reads.
    accepted: undefined as Promise<boolean> | undefined
  },
  sendNativeChatMessage: vi.fn(),
  sendNativeChatMessageWithImageAttachments: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  trackPendingSend: vi.fn(),
  setDraft: vi.fn(),
  draftScopeKeys: [] as string[],
  clearNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchDraftAdopted: vi.fn()
}))

vi.mock('../../store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    agentStatusByPaneKey: {},
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: mocks.clearNativeChatLaunchDraft,
    markNativeChatLaunchDraftAdopted: mocks.markNativeChatLaunchDraftAdopted
  }
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
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
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args),
  sendNativeChatTypedCommand: (...args: unknown[]) => mocks.sendNativeChatTypedCommand(...args),
  sendNativeChatMessageVerified: (...args: unknown[]) =>
    mocks.sendNativeChatMessageVerified(...args),
  typeNativeChatCommand: (...args: unknown[]) => mocks.typeNativeChatCommand(...args),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: (...args: unknown[]) =>
    mocks.sendNativeChatMessageWithImageAttachments(...args)
}))
vi.mock('./claude-model-switch-confirmation', () => ({
  createClaudeModelSwitchConfirmationObserver: (...args: unknown[]) =>
    mocks.createClaudeModelSwitchConfirmationObserver(...args)
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('./use-native-chat-draft', () => ({
  useNativeChatDraft: (scopeKey: string) => {
    mocks.draftScopeKeys.push(scopeKey)
    return { draft: mocks.draft, setDraft: mocks.setDraft }
  }
}))
vi.mock('./native-chat-draft-cache', () => ({
  readNativeChatDraftCache: () => ''
}))
vi.mock('./NativeChatComposerField', () => ({
  NativeChatComposerField: (props: { onSend?: () => void; onStop?: () => void }) => {
    mocks.fieldProps = props
    return <div data-testid="native-chat-composer-field" />
  }
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('./use-native-chat-composer-attachments', () => ({
  useNativeChatComposerAttachments: (args: { isComposing: () => boolean }) => {
    mocks.attachmentIsComposing = args.isComposing
    return {
      imageAttachments: mocks.imageAttachments,
      attachResolvedPaths: vi.fn(),
      clearImageAttachments: vi.fn(),
      flushPendingAttachments: mocks.flushPendingAttachments,
      removeImageAttachment: vi.fn()
    }
  }
}))
vi.mock('./use-native-chat-composer-paste', () => ({
  useNativeChatComposerPaste: () => ({
    handlePaste: vi.fn(),
    pasteFromClipboard: vi.fn()
  })
}))
vi.mock('./use-native-chat-external-attachments', () => ({
  useNativeChatExternalAttachments: () => ({
    attachExternalPaths: vi.fn(),
    resolveAttachmentOwner: vi.fn()
  })
}))
vi.mock('../dictation/dictation-control-events', () => ({
  dispatchDictationControl: vi.fn()
}))
vi.mock('./use-native-chat-composer-keydown', () => ({
  useNativeChatComposerKeyDown: (args: { isComposing: () => boolean }) => {
    mocks.composerIsComposing = args.isComposing
    return vi.fn()
  }
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
    clearNativeChatSessionOptionCacheForTests()
    clearNativeChatModelEnrichmentForTests()
    mocks.fieldProps = null
    mocks.modelSwitchOutcome = 'applied'
    mocks.draft = 'hello'
    mocks.imageAttachments = []
    mocks.draftScopeKeys.length = 0
    mocks.confirmationObserver = null
    mocks.composerIsComposing = null
    mocks.attachmentIsComposing = null
    mocks.createClaudeModelSwitchConfirmationObserver.mockImplementation(() => {
      const observer = {
        ready: Promise.resolve(),
        result: Promise.resolve(mocks.modelSwitchOutcome),
        arm: vi.fn(),
        startDetection: vi.fn(),
        dispose: vi.fn()
      }
      mocks.confirmationObserver = observer
      return observer
    })
    mocks.getMainBufferSnapshot.mockResolvedValue(null)
    mocks.discoverCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'probe',
      models: [
        {
          id: 'opus',
          label: 'Opus',
          thinkingLevels: [
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' }
          ]
        },
        {
          id: 'sonnet',
          label: 'Sonnet',
          thinkingLevels: [
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' }
          ]
        },
        { id: 'fable', label: 'Fable' }
      ]
    })
    mocks.sendNativeChatMessage.mockReturnValue(mocks.sendHandle)
    mocks.sendNativeChatMessageWithImageAttachments.mockReturnValue(mocks.sendHandle)
    mocks.sendNativeChatTypedCommand.mockReturnValue(mocks.sendHandle)
    mocks.sendNativeChatMessageVerified.mockResolvedValue(true)
    mocks.typeNativeChatCommand.mockResolvedValue(true)
    mocks.sendHandle.settleAfterMs = 500
    mocks.sendHandle.accepted = undefined
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        git: { discoverCommitMessageModels: mocks.discoverCommitMessageModels },
        pty: { getMainBufferSnapshot: mocks.getMainBufferSnapshot },
        ui: { onFileDrop: () => vi.fn() }
      }
    })
  })

  afterEach(() => cleanup())

  it('keeps an editable remote draft when semantic submission is rejected', async () => {
    mocks.sendHandle.accepted = Promise.resolve(false)
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="remote:env-1@@term-1"
        agent="codex"
      />
    )

    await act(async () => mocks.fieldProps?.onSend?.())

    expect(mocks.setDraft).not.toHaveBeenCalledWith('')
    expect(mocks.clearNativeChatLaunchDraft).not.toHaveBeenCalled()
    expect(mocks.trackPendingSend).toHaveBeenCalledWith(mocks.sendHandle)
  })

  it('clears a remote draft only after semantic submission is accepted', async () => {
    mocks.sendHandle.accepted = Promise.resolve(true)
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="remote:env-1@@term-1"
        agent="codex"
      />
    )

    await act(async () => mocks.fieldProps?.onSend?.())

    expect(mocks.setDraft).toHaveBeenCalledWith('')
    expect(mocks.clearNativeChatLaunchDraft).toHaveBeenCalledWith('tab-1')
  })

  it('blocks duplicate remote submits while semantic acceptance is pending', async () => {
    let resolveAccepted!: (accepted: boolean) => void
    mocks.sendHandle.accepted = new Promise<boolean>((resolve) => {
      resolveAccepted = resolve
    })
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="remote:env-1@@term-1"
        agent="codex"
      />
    )

    act(() => {
      mocks.fieldProps?.onSend?.()
      mocks.fieldProps?.onSend?.()
    })

    expect(mocks.sendNativeChatMessage).toHaveBeenCalledOnce()
    await act(() => {
      resolveAccepted(true)
    })
  })
})
