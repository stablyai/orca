// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import type * as nativeChatAgentProfiles from '../../../../shared/native-chat-agent-profiles'
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
  imageAttachments: [] as { id: string; path: string }[],
  getMainBufferSnapshot: vi.fn(),
  sendHandle: { cancel: vi.fn(), settleAfterMs: 500 },
  sendNativeChatMessage: vi.fn(),
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
  sendNativeChatMessageWithImageAttachments: vi.fn()
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
    mocks.sendNativeChatTypedCommand.mockReturnValue(mocks.sendHandle)
    mocks.sendNativeChatMessageVerified.mockResolvedValue(true)
    mocks.typeNativeChatCommand.mockResolvedValue(true)
    mocks.sendHandle.settleAfterMs = 500
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

  it('routes structured sends and hydrated options through the existing composer', async () => {
    const send = vi.fn(() => true)
    const dispatchCommand = vi.fn(async () => ({
      handled: false,
      accepted: false,
      error: null
    }))
    const optionsSurface = {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    } satisfies SessionOptionsSurface
    const optionSnapshot = [{ id: 'model' }] as SessionOptionDescriptor[]
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:structured"
        targetPtyId={null}
        agent="codex"
        structuredTransport={{
          send,
          dispatchCommand,
          optionsSurface,
          optionSnapshot,
          onError: vi.fn(),
          runtime: 'local'
        }}
      />
    )

    expect(mocks.fieldProps?.sessionOptionsSurface).toBe(optionsSurface)
    expect(mocks.fieldProps?.sessionOptionsSnapshot).toBe(optionSnapshot)
    expect(mocks.fieldProps?.attachDisabled).toBe(false)
    await act(async () => mocks.fieldProps?.onSend?.())

    expect(dispatchCommand).toHaveBeenCalledWith('hello')
    expect(send).toHaveBeenCalledWith('hello', [])
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    expect(mocks.setDraft).toHaveBeenCalledWith('')
  })

  it('sends structured image attachments through the durable transport', async () => {
    mocks.draft = ''
    mocks.imageAttachments = [{ id: 'image-1', path: '/tmp/image.png' }]
    const send = vi.fn(() => true)
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:structured"
        targetPtyId={null}
        agent="codex"
        structuredTransport={{
          send,
          dispatchCommand: vi.fn(async () => ({
            handled: false,
            accepted: false,
            error: null
          })),
          optionsSurface: {
            getSnapshot: () => [],
            setOption: vi.fn(),
            invokeAction: vi.fn(),
            subscribe: () => () => {}
          },
          optionSnapshot: [],
          worktreeId: 'wt-1',
          onError: vi.fn(),
          runtime: 'local'
        }}
      />
    )

    await act(async () => mocks.fieldProps?.onSend?.())

    expect(send).toHaveBeenCalledWith('', mocks.imageAttachments)
    expect(mocks.setDraft).toHaveBeenCalledWith('')
  })

  it('types Codex slash composer sends instead of pasting them', () => {
    mocks.draft = '/status'
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
      />
    )

    act(() => mocks.fieldProps?.onSend?.())

    expect(mocks.sendNativeChatTypedCommand).toHaveBeenCalledWith({}, 'pty-1', '/status')
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it('keeps Codex skill sends pasted', () => {
    mocks.draft = '$ref-oss'
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
      />
    )

    act(() => mocks.fieldProps?.onSend?.())

    expect(mocks.sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', '$ref-oss', undefined)
    expect(mocks.sendNativeChatTypedCommand).not.toHaveBeenCalled()
  })

  it.each(['claude', 'openclaude'] as const)('keeps %s slash composer sends pasted', (agent) => {
    mocks.draft = '/clear'
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent={agent}
      />
    )

    act(() => mocks.fieldProps?.onSend?.())

    expect(mocks.sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', '/clear', undefined)
    expect(mocks.sendNativeChatTypedCommand).not.toHaveBeenCalled()
  })

  it('retires the launch-draft seed once a send clears the TUI input line', () => {
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
      />
    )
    expect(mocks.clearNativeChatLaunchDraft).not.toHaveBeenCalled()

    act(() => mocks.fieldProps?.onSend?.())

    expect(mocks.clearNativeChatLaunchDraft).toHaveBeenCalledWith('tab-1')
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

  it('shares one stable composition owner between keyboard and attachment paths', () => {
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
      />
    )

    expect(mocks.attachmentIsComposing).toBe(mocks.composerIsComposing)
    act(() => mocks.fieldProps?.imeEnterGesture?.setComposing(true))
    expect(mocks.attachmentIsComposing?.()).toBe(true)
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

  it('does not duplicate a composition value already adopted by onChange', () => {
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="codex"
      />
    )
    const textarea = document.createElement('textarea')
    textarea.value = 'hello'
    mocks.setDraft.mockClear()
    mocks.flushPendingAttachments.mockClear()

    act(() => mocks.fieldProps?.onImeSettled?.(textarea))

    expect(mocks.setDraft).not.toHaveBeenCalled()
    expect(mocks.flushPendingAttachments).toHaveBeenCalledOnce()
  })

  it('renders the Claude model picker while host discovery is still pending', () => {
    mocks.discoverCommitMessageModels.mockReturnValue(new Promise(() => {}))
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="claude"
        readTerminalScreen={() => null}
      />
    )

    expect(mocks.fieldProps?.sessionOptionsSnapshot?.[0]).toMatchObject({
      id: 'model',
      kind: {
        choices: expect.arrayContaining([
          expect.objectContaining({ value: 'opus', label: 'Opus' }),
          expect.objectContaining({ value: 'sonnet', label: 'Sonnet' })
        ])
      }
    })
  })

  it('keeps the Claude model picker when an older remote runtime omits the catalog origin', async () => {
    mocks.discoverCommitMessageModels.mockResolvedValue({
      success: true,
      defaultModelId: 'sonnet',
      models: [{ id: 'sonnet', label: 'Sonnet' }]
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

    await waitFor(() => expect(mocks.discoverCommitMessageModels).toHaveBeenCalled())
    await act(async () => undefined)

    expect(mocks.fieldProps?.sessionOptionsSnapshot?.[0]).toMatchObject({
      id: 'model',
      kind: {
        choices: expect.arrayContaining([
          expect.objectContaining({ value: 'fable', label: 'Fable' }),
          expect.objectContaining({ value: 'haiku', label: 'Haiku' })
        ])
      }
    })
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
      expectedModelLabel: 'Opus'
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

  it('types the Codex picker command and switches to the terminal', async () => {
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

    await act(async () => {
      await mocks.fieldProps?.sessionOptionsSurface?.invokeAction('model')
    })

    expect(mocks.typeNativeChatCommand).toHaveBeenCalledWith(
      {},
      'pty-1',
      '/model',
      expect.any(AbortSignal)
    )
    expect(mocks.sendNativeChatMessageVerified).not.toHaveBeenCalled()
    expect(onSwitchToTerminal).toHaveBeenCalledOnce()
  })
})
