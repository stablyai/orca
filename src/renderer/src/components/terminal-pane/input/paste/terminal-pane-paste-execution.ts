import { recordRecentTerminalImage } from '../recent-terminal-images'
import { useAppStore } from '../../../../store/index'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
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
import { recordTerminalUserInputForLeaf } from '../terminal-input-activity'
import { scheduleImagePasteWebglAtlasRecovery } from '../../render-health/terminal-webgl-atlas-recovery'
import { pasteTerminalClipboard } from '../../clipboard/terminal-clipboard-paste'
import { createTerminalClipboardCopiedFiles } from '../../clipboard/terminal-clipboard-copied-files'
import type { ReadClipboardTextOptions } from '../../../../../../shared/clipboard/clipboard-text'
import type { TerminalPaneCloseController } from '../../layout/close/use-terminal-pane-close-actions'
import { resolveProtectedMultilinePasteOptionsForPane } from './terminal-agent-paste-bracketing'
import { resolveTerminalInputHostPlatform } from '../terminal-input-host-platform'
import { requestNativePasteForUnreadWindowsClipboard } from './terminal-unread-clipboard-native-paste'

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
    cwd,
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
  ): Promise<boolean> => {
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
      return false
    }
    if (text) {
      recordTerminalUserInputForLeaf(tabId, pane.leafId)
    }
    if (options?.recoverImagePasteWebglAtlas) {
      scheduleImagePasteWebglAtlasRecovery()
    }
    return true
  }

  // Resolve per pane/PTY host: Windows Codex needs input-record newlines even beside other protocols.
  const resolvePaneProtectedMultilinePasteOptions = (
    pane: ManagedPane
  ): TerminalPasteTextOptions | undefined => {
    const state = useAppStore.getState()
    const options = resolveProtectedMultilinePasteOptionsForPane({
      isWindowsClient: forceBracketedMultilineTextPaste,
      hostPlatform: resolveTerminalInputHostPlatform({
        clientPlatform: shortcutPlatform,
        state,
        statuses: readRuntimeStatuses(),
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

  const createPaneClipboardCopiedFiles = (pane: ManagedPane) =>
    createTerminalClipboardCopiedFiles({
      managerRef,
      paneTransportsRef,
      worktreeId,
      tabId,
      cwd,
      pane
    })

  const pasteFromClipboard = (
    pane: ManagedPane,
    source: Extract<TerminalPasteSource, 'keyboard' | 'paste-event'>,
    {
      readClipboardText = window.api.ui.readClipboardText,
      eventCopiedFilePaths
    }: {
      readClipboardText?: (options?: ReadClipboardTextOptions) => Promise<string>
      eventCopiedFilePaths?: string[]
    } = {}
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
      copiedFiles: createPaneClipboardCopiedFiles(pane),
      eventCopiedFilePaths,
      connectionId,
      runtimeEnvironmentId,
      onLocalImagePasted: (path) => recordRecentTerminalImage(pane.terminal, path, true),
      protectedMultilineTextPasteOptions: resolvePaneProtectedMultilinePasteOptions(pane),
      pasteText: (text, options) =>
        executePanePasteText(pane, source, activeElementAtDispatch, text, options),
      onTextPasteError: () =>
        setTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.'),
      onImagePasteError: (error) => setTerminalError(formatClipboardImagePasteError(error))
    })
      .then((result) => {
        // The paste event this may trigger must not fall back again.
        if (source === 'keyboard') {
          requestNativePasteForUnreadWindowsClipboard(result, pane)
        }
      })
      .catch(() => {
        setTerminalError('Paste failed.')
      })
  }

  return {
    createPaneClipboardCopiedFiles,
    executePanePasteText,
    pasteFromClipboard,
    resolvePaneProtectedMultilinePasteOptions
  }
}
