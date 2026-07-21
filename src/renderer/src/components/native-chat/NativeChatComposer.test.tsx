// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import type * as nativeChatAgentProfiles from '../../../../shared/native-chat-agent-profiles'
import { clearNativeChatSessionOptionCacheForTests } from './native-chat-session-option-cache'

const mocks = vi.hoisted(() => ({
  cancelPendingSends: vi.fn(),
  fieldProps: null as {
    onSend?: () => void
    onStop?: () => void
    sessionOptionsSurface?: SessionOptionsSurface | null
    sessionOptionsSnapshot?: SessionOptionDescriptor[]
  } | null,
  modelSwitchOutcome: 'applied' as 'applied' | 'rejected' | 'interaction-required' | 'unknown',
  confirmationObserver: null as {
    ready: Promise<void>
    result: Promise<'applied' | 'rejected' | 'interaction-required' | 'unknown'>
    arm: ReturnType<typeof vi.fn>
    startDetection: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  } | null,
  createClaudeModelSwitchConfirmationObserver: vi.fn(),
  getMainBufferSnapshot: vi.fn(),
  sendHandle: { cancel: vi.fn(), settleAfterMs: 500 },
  sendNativeChatMessage: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(),
  trackPendingSend: vi.fn(),
  setDraft: vi.fn(),
  draftScopeKeys: [] as string[]
}))

vi.mock('../../store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    updateSettings: vi.fn()
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
  sendNativeChatMessageVerified: (...args: unknown[]) =>
    mocks.sendNativeChatMessageVerified(...args),
  sendNativeChatMessageWithImageAttachments: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./claude-model-switch-confirmation', () => ({
  createClaudeModelSwitchConfirmationObserver: (...args: unknown[]) =>
    mocks.createClaudeModelSwitchConfirmationObserver(...args)
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
vi.mock('./use-native-chat-draft', () => ({
  useNativeChatDraft: (scopeKey: string) => {
    mocks.draftScopeKeys.push(scopeKey)
    return { draft: 'hello', setDraft: mocks.setDraft }
  }
}))
vi.mock('./native-chat-draft-cache', () => ({
  readNativeChatDraftCache: () => ''
}))
vi.mock('./NativeChatComposerField', () => ({
  NativeChatComposerField: (props: { onSend?: () => void; onStop?: () => void }) => {
    mocks.fieldProps = props
    return null
  }
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('./use-native-chat-composer-attachments', () => ({
  useNativeChatComposerAttachments: () => ({
    imageAttachments: [],
    attachResolvedPaths: vi.fn(),
    clearImageAttachments: vi.fn(),
    removeImageAttachment: vi.fn()
  })
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
    clearNativeChatSessionOptionCacheForTests()
    mocks.fieldProps = null
    mocks.modelSwitchOutcome = 'applied'
    mocks.draftScopeKeys.length = 0
    mocks.confirmationObserver = null
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
    mocks.sendNativeChatMessage.mockReturnValue(mocks.sendHandle)
    mocks.sendNativeChatMessageVerified.mockResolvedValue(true)
    mocks.sendHandle.settleAfterMs = 500
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        pty: { getMainBufferSnapshot: mocks.getMainBufferSnapshot },
        ui: { onFileDrop: () => vi.fn() }
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

  it('associates a delayed submit with its optimistic cache entry', () => {
    const onOptimisticSend = vi.fn(() => 'pending-1')
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
        onOptimisticSend={onOptimisticSend}
      />
    )

    act(() => mocks.fieldProps?.onSend?.())

    expect(onOptimisticSend).toHaveBeenCalledWith('hello', [])
    expect(mocks.trackPendingSend).toHaveBeenCalledWith(mocks.sendHandle, 'pending-1')
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
  })

  it('shows the model already selected in the Claude TUI when chat opens', async () => {
    mocks.getMainBufferSnapshot.mockResolvedValue({
      data: 'Claude Code v2.1.211\r\nOpus 4.8 with medium effort · API Usage Billing',
      cols: 120,
      rows: 40
    })
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="claude"
        readTerminalScreen={() => null}
      />
    )

    await waitFor(() =>
      expect(mocks.fieldProps?.sessionOptionsSnapshot).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'model',
            valueSource: 'reported',
            kind: expect.objectContaining({ currentValue: 'opus' })
          }),
          expect.objectContaining({
            id: 'effort',
            valueSource: 'reported',
            kind: expect.objectContaining({ currentValue: 'medium' })
          })
        ])
      )
    )
    expect(mocks.getMainBufferSnapshot).toHaveBeenCalledWith('pty-1', { scrollbackRows: 0 })
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

  it('observes a fresh Claude model choice and stays native on success', async () => {
    mocks.sendHandle.settleAfterMs = 0
    const onSlashCommand = vi.fn()
    const onOptimisticSend = vi.fn()
    const onSwitchToTerminal = vi.fn()
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="claude"
        onSlashCommand={onSlashCommand}
        onOptimisticSend={onOptimisticSend}
        onSwitchToTerminal={onSwitchToTerminal}
      />
    )

    await act(async () => {
      await mocks.fieldProps?.sessionOptionsSurface?.setOption('model', 'opus')
    })

    expect(mocks.sendNativeChatMessageVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      '/model opus',
      expect.any(AbortSignal)
    )
    expect(onSlashCommand).toHaveBeenCalledWith('/model opus')
    expect(onOptimisticSend).not.toHaveBeenCalled()
    expect(mocks.createClaudeModelSwitchConfirmationObserver).toHaveBeenCalledWith({
      ptyId: 'pty-1',
      settings: {},
      expectedModelLabel: 'Opus 4.8'
    })
    expect(onSwitchToTerminal).not.toHaveBeenCalled()
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
      {},
      'pty-1',
      '/model fable',
      expect.any(AbortSignal)
    )
    expect(mocks.createClaudeModelSwitchConfirmationObserver).toHaveBeenCalledWith({
      ptyId: 'pty-1',
      settings: {},
      expectedModelLabel: 'Fable 5'
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

  it('reveals Claude interaction only when the model switch needs user input', async () => {
    mocks.sendHandle.settleAfterMs = 0
    mocks.modelSwitchOutcome = 'interaction-required'
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
      {},
      'pty-1',
      '/model fable',
      expect.any(AbortSignal)
    )
    expect(onSwitchToTerminal).toHaveBeenCalledOnce()
  })

  it('waits for the Codex picker command before switching to the terminal', async () => {
    mocks.sendHandle.settleAfterMs = 0
    const onSwitchToTerminal = vi.fn()
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
        onSwitchToTerminal={onSwitchToTerminal}
      />
    )

    // Why: Codex model is agent-picker mid-session — setOption rejects; UI uses invokeAction.
    await act(async () => {
      await mocks.fieldProps?.sessionOptionsSurface?.invokeAction('model')
    })

    expect(mocks.sendNativeChatMessageVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      '/model',
      expect.any(AbortSignal)
    )
    expect(onSwitchToTerminal).toHaveBeenCalledOnce()
  })
})
