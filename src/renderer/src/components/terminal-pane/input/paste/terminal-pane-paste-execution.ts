import { useAppStore } from '../../../../store/index'
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
import type { ReadClipboardTextOptions } from '../../../../../../shared/clipboard-text'
import type { TerminalPaneCloseController } from '../../layout/close/use-terminal-pane-close-actions'
import { resolveProtectedMultilinePasteOptionsForPane } from './terminal-agent-paste-bracketing'
import { resolveTerminalInputHostPlatform } from '../terminal-input-host-platform'
import {
  createClipboardImagePasteEnterHold,
  type ClipboardImagePasteEnterHold
} from './clipboard-image-paste-enter-hold'

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

  // Holds a plain Enter typed while a pane's clipboard image upload is in flight (#41502).
  const clipboardImageEnterHold: ClipboardImagePasteEnterHold = createClipboardImagePasteEnterHold({
    getPanes: () => managerRef.current?.getPanes()
  })

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
      copiedFiles: createPaneClipboardCopiedFiles(pane),
      connectionId,
      runtimeEnvironmentId,
      protectedMultilineTextPasteOptions: resolvePaneProtectedMultilinePasteOptions(pane),
      pasteText: (text, options) =>
        executePanePasteText(pane, source, activeElementAtDispatch, text, options),
      onTextPasteError: () =>
        setTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.'),
      onImagePasteError: (error) => setTerminalError(formatClipboardImagePasteError(error)),
      onImagePasteUploadStart: () => clipboardImageEnterHold.noteImageUploadStart(pane.id)
    })
      .then((result) =>
        clipboardImageEnterHold.settleImageUpload(
          pane.id,
          result.status === 'pasted' && result.kind === 'image-path'
        )
      )
      .catch(() => {
        clipboardImageEnterHold.settleImageUpload(pane.id, false)
        setTerminalError('Paste failed.')
      })
  }

  return {
    clipboardImageEnterHold,
    createPaneClipboardCopiedFiles,
    executePanePasteText,
    pasteFromClipboard,
    resolvePaneProtectedMultilinePasteOptions
  }
}
