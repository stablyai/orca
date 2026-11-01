// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat/input/native-chat-session-options'
import { clearNativeChatSessionOptionCacheForTests } from './native-chat-session-option-cache'
import { clearNativeChatModelEnrichmentForTests } from './native-chat-session-option-enrichment'
import type * as RemoteRuntimePtyIdModule from '../../../../shared/remote-runtime/remote-runtime-pty-id'

const mocks = vi.hoisted(() => ({
  cancelPendingSends: vi.fn(),
  composerIsComposing: null as (() => boolean) | null,
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
  sendHandle: { cancel: vi.fn(), settleAfterMs: 500 },
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
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('../../../../shared/remote-runtime/remote-runtime-pty-id', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
  isRemoteRuntimePtyId: () => false
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
    return { draft: mocks.draft, setDraft: mocks.setDraft, flushDraftAppends: () => {} }
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
  useNativeChatComposerAttachments: () => {
    return {
      imageAttachments: mocks.imageAttachments,
      attachResolvedPaths: vi.fn(),
      clearImageAttachments: vi.fn(),
      flushPendingAttachments: mocks.flushPendingAttachments,
      removeImageAttachment: vi.fn(),
      pendingChips: { begin: vi.fn(), resolve: vi.fn(), drop: vi.fn(), attachReferences: vi.fn() }
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
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'

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
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        git: { discoverCommitMessageModels: mocks.discoverCommitMessageModels },
        pty: { getMainBufferSnapshot: mocks.getMainBufferSnapshot }
      }
    })
  })

  afterEach(() => cleanup())

  it('cancels delayed composer writes before the Stop button interrupts the agent', () => {
    const onStop = vi.fn()
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
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

  it('writes nothing from a composer hidden under a prompt card that still holds focus', () => {
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="claude"
        inputOwnedByCard
      />
    )
    act(() => mocks.fieldProps?.onSend?.())
    act(() => mocks.fieldProps?.onStop?.())
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    expect(sendRuntimePtyInput).not.toHaveBeenCalled()
  })

  it('disables Send and blocks a send while an image attachment is still pending', () => {
    mocks.imageAttachments = [{ id: 'image-1', path: '', pending: true }]
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
      />
    )

    expect(mocks.fieldProps?.sendButtonDisabled).toBe(true)

    act(() => mocks.fieldProps?.onSend?.())

    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatTypedCommand).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatMessageWithImageAttachments).not.toHaveBeenCalled()
  })

  it('keeps the draft scope anchored to the pane while the PTY reconnects', () => {
    const view = render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-before"
        agent="codex"
      />
    )
    const field = view.getByTestId('native-chat-composer-field')

    view.rerender(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId={null}
        agent="codex"
      />
    )
    view.rerender(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-after"
        agent="codex"
      />
    )

    expect(new Set(mocks.draftScopeKeys)).toEqual(new Set(['tab-1:leaf-1']))
    expect(view.getByTestId('native-chat-composer-field')).toBe(field)
  })

  it('remounts the composer field when draft ownership moves to another pane', () => {
    const view = render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
      />
    )
    const previousField = view.getByTestId('native-chat-composer-field')
    act(() => mocks.fieldProps?.imeEnterGesture?.setComposing(true))
    expect(mocks.composerIsComposing?.()).toBe(true)

    view.rerender(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-2"
        targetPtyId="pty-2"
        agent="codex"
      />
    )

    expect(view.getByTestId('native-chat-composer-field')).not.toBe(previousField)
    expect(mocks.composerIsComposing?.()).toBe(false)
  })

  it('adopts an IME deletion delivered only by compositionend', () => {
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
      />
    )
    const textarea = document.createElement('textarea')
    textarea.value = ''
    mocks.setDraft.mockClear()
    mocks.flushPendingAttachments.mockClear()

    act(() => {
      mocks.fieldProps?.imeEnterGesture?.setComposing(false)
      mocks.fieldProps?.onImeSettled?.(textarea)
    })

    expect(mocks.setDraft).toHaveBeenCalledOnce()
    expect(mocks.setDraft).toHaveBeenCalledWith('')
    expect(mocks.flushPendingAttachments).toHaveBeenCalledOnce()
    expect(mocks.setDraft.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.flushPendingAttachments.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('reads Claude state from mounted xterm while its alternate screen is active', async () => {
    mocks.getMainBufferSnapshot.mockResolvedValue({
      data: 'Claude Code v2.1.211\r\nOpus 4.8 with high effort · stale main buffer',
      cols: 120,
      rows: 40,
      alternateScreen: true
    })
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="claude"
        readTerminalScreen={() =>
          '\u001b[?1049h\u001b[HClaude Codev2.1.211\r\n' +
          'Sonnet 5 with medium effort · API Usage Billing'
        }
      />
    )

    await waitFor(() =>
      expect(mocks.fieldProps?.sessionOptionsSnapshot).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'model',
            valueSource: 'reported',
            kind: expect.objectContaining({ currentValue: 'sonnet' })
          }),
          expect.objectContaining({
            id: 'effort',
            valueSource: 'reported',
            kind: expect.objectContaining({ currentValue: 'medium' })
          })
        ])
      )
    )
  })

  it('keeps a successful Claude model change after a conversation in native chat', async () => {
    mocks.sendHandle.settleAfterMs = 0
    const onSwitchToTerminal = vi.fn()
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="claude"
        onSwitchToTerminal={onSwitchToTerminal}
      />
    )

    await act(async () => {
      await mocks.fieldProps?.sessionOptionsSurface?.setOption('model', 'fable')
    })

    expect(mocks.sendNativeChatMessageVerified).toHaveBeenCalledWith(
      'pty-1',
      '/model fable',
      expect.any(AbortSignal)
    )
    expect(mocks.createClaudeModelSwitchConfirmationObserver).toHaveBeenCalledWith({
      ptyId: 'pty-1',
      expectedModelLabel: 'Fable'
    })
    expect(mocks.confirmationObserver?.arm).toHaveBeenCalledOnce()
    expect(mocks.confirmationObserver?.arm.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendNativeChatMessageVerified.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(mocks.confirmationObserver?.startDetection).toHaveBeenCalledOnce()
    expect(mocks.confirmationObserver?.startDetection.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.sendNativeChatMessageVerified.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY
    )
    expect(mocks.confirmationObserver?.dispose).toHaveBeenCalledOnce()
    expect(onSwitchToTerminal).not.toHaveBeenCalled()
  })
})
