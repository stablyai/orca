import { useAppStore } from '../../store'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport-types'
import { getConnectionId } from '@/lib/connection-context'
import type { TerminalPasteSource, TerminalPasteTextOptions } from './terminal-paste-model'
import {
  resolveTerminalPasteRuntime,
  resolveTerminalPasteRuntimeEnvironmentId
} from './terminal-paste-runtime'
import {
  isTerminalPanePasteFocusCurrent,
  isTerminalPanePasteTargetCurrent
} from './terminal-paste-target-state'
import { pasteTextIntoTerminalPane } from './terminal-pane-paste-dispatch'
import { formatTerminalPasteExecutionError } from './terminal-paste-errors'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { scheduleImagePasteWebglAtlasRecovery } from './terminal-webgl-atlas-recovery'
import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import type { ReadClipboardTextOptions } from '../../../../shared/clipboard-text'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'
import { resolveProtectedMultilinePasteOptionsForPane } from './terminal-agent-paste-bracketing'
import { resolveTerminalInputHostPlatform } from './terminal-input-host-platform'

export type TerminalPanePasteExecution = ReturnType<typeof createTerminalPanePasteExecution>

export function formatClipboardImagePasteError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Image paste failed: ${detail}`
}

export function createTerminalPanePasteExecution(
  controller: TerminalPaneCloseController,
  shortcutPlatform: NodeJS.Platform
) {
  const {
    forceBracketedMultilineTextPaste,
    managerRef,
    paneTransportsRef,
    setTerminalError,
    tabId,
    worktreeId
  } = controller
  const isPanePasteTargetMounted = (
    pane: ManagedPane,
    transport: PtyTransport | undefined,
    ptyId: string | null
  ): boolean =>
    isTerminalPanePasteTargetCurrent({
      manager: managerRef.current,
      paneTransports: paneTransportsRef.current,
      paneId: pane.id,
      leafId: pane.leafId,
      transport,
      ptyId
    })

  const executePanePasteText = async (
    pane: ManagedPane,
    source: TerminalPasteSource,
    activeElementAtDispatch: Element | null,
    text: string,
    options?: TerminalPasteTextOptions
  ): Promise<void> => {
    const transport = paneTransportsRef.current.get(pane.id)
    const ptyId = transport?.getPtyId() ?? null
    const keyboardOwnedPaste =
      source === 'keyboard' || source === 'paste-event' || source === 'app-menu'
    const execution = await pasteTextIntoTerminalPane({
      pane,
      text,
      source,
      ptyId,
      runtime: resolveTerminalPasteRuntime({
        platform: shortcutPlatform,
        ptyId,
        transport,
        isWindowsConpty: forceBracketedMultilineTextPaste
      }),
      transport,
      inputKind: 'driving',
      isTargetCurrent: () => {
        if (!isPanePasteTargetMounted(pane, transport, ptyId)) {
          return false
        }
        return isTerminalPanePasteFocusCurrent({
          requireSameFocusedElement: keyboardOwnedPaste,
          activeElementAtDispatch,
          paneContainer: pane.container
        })
      },
      canContinue: () => isPanePasteTargetMounted(pane, transport, ptyId),
      planOptions: options
    })
    if (execution.status !== 'pasted') {
      setTerminalError(formatTerminalPasteExecutionError(execution.reason))
      return
    }
    if (text) {
      recordTerminalUserInputForLeaf(tabId, pane.leafId)
    }
    if (options?.recoverImagePasteWebglAtlas) {
      scheduleImagePasteWebglAtlasRecovery()
    }
  }

  // Why: resolved per pane and PTY host; split siblings and remote hosts can need
  // different multiline paste protocols (Windows Codex needs input-record newlines).
  const resolvePaneProtectedMultilinePasteOptions = (
    pane: ManagedPane
  ): TerminalPasteTextOptions | undefined => {
    const state = useAppStore.getState()
    const options = resolveProtectedMultilinePasteOptionsForPane({
      isWindowsClient: forceBracketedMultilineTextPaste,
      hostPlatform: resolveTerminalInputHostPlatform({
        clientPlatform: shortcutPlatform,
        state,
        worktreeId,
        transport: paneTransportsRef.current.get(pane.id) ?? null
      }),
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey,
      tabId,
      leafId: pane.leafId
    })
    // Why: non-Windows clients keep xterm's own bracketing; only the Windows input-record contract is added.
    return forceBracketedMultilineTextPaste || options?.windowsInputRecordNewline
      ? options
      : undefined
  }

  const pasteFromClipboard = (
    pane: ManagedPane,
    source: Extract<TerminalPasteSource, 'keyboard' | 'paste-event'>,
    readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string> = window.api.ui
      .readClipboardText
  ): void => {
    const connectionId = getConnectionId(worktreeId) ?? null
    const runtimeEnvironmentId = resolveTerminalPasteRuntimeEnvironmentId(
      useAppStore.getState(),
      worktreeId,
      paneTransportsRef.current.get(pane.id)
    )
    const activeElementAtDispatch = document.activeElement
    void pasteTerminalClipboard({
      readClipboardText,
      saveClipboardImageAsTempFile: window.api.ui.saveClipboardImageAsTempFile,
      connectionId,
      runtimeEnvironmentId,
      protectedMultilineTextPasteOptions: resolvePaneProtectedMultilinePasteOptions(pane),
      pasteText: (text, options) =>
        executePanePasteText(pane, source, activeElementAtDispatch, text, options),
      onTextPasteError: () =>
        setTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.'),
      onImagePasteError: (error) => setTerminalError(formatClipboardImagePasteError(error))
    }).catch(() => {
      setTerminalError('Paste failed.')
    })
  }

  return { executePanePasteText, pasteFromClipboard, resolvePaneProtectedMultilinePasteOptions }
}
