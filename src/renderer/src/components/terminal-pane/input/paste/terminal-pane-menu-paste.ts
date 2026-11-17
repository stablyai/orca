import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import { requestNativeChatCoverPaste } from './native-chat-cover-paste'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { pasteTerminalClipboard } from '../../clipboard/terminal-clipboard-paste'
import { createTerminalClipboardCopiedFiles } from '../../clipboard/terminal-clipboard-copied-files'
import type { TerminalPasteSource, TerminalPasteTextOptions } from './terminal-paste-model'
import { formatTerminalPasteExecutionError } from './terminal-paste-errors'
import {
  resolveTerminalPasteRuntime,
  resolveTerminalPasteRuntimeEnvironmentId
} from './terminal-paste-runtime'
import { isTerminalPanePasteTargetCurrent } from './terminal-paste-target-state'
import { pasteTextIntoTerminalPane } from './terminal-pane-paste-dispatch'
import { scheduleImagePasteWebglAtlasRecovery } from '../../render-health/terminal-webgl-atlas-recovery'
import { useAppStore } from '@/store/index'
import { resolveProtectedMultilinePasteOptionsForPane } from './terminal-agent-paste-bracketing'
import { resolveTerminalInputHostPlatform } from '../terminal-input-host-platform'
import { recordTerminalUserInputForLeaf } from '../terminal-input-activity'
import type {
  ClipboardImagePasteEnterHold,
  ClipboardImageUploadToken
} from './clipboard-image-paste-enter-hold'

export type TerminalPaneMenuPasteContext = {
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  tabId: string
  worktreeId: string
  cwd?: string
  forceBracketedMultilineTextPaste: boolean
  onPasteError: (message: string) => void
  clipboardImageEnterHold: ClipboardImagePasteEnterHold
}

const isPanePasteTargetMounted = (
  context: TerminalPaneMenuPasteContext,
  pane: ManagedPane,
  transport: PtyTransport | undefined,
  ptyId: string | null
): boolean => {
  return isTerminalPanePasteTargetCurrent({
    manager: context.managerRef.current,
    paneTransports: context.paneTransportsRef.current,
    paneId: pane.id,
    leafId: pane.leafId,
    transport,
    ptyId
  })
}

export const executeTerminalPaneMenuPasteText = async (
  context: TerminalPaneMenuPasteContext,
  pane: ManagedPane,
  source: TerminalPasteSource,
  text: string,
  options?: TerminalPasteTextOptions
): Promise<boolean> => {
  const transport = context.paneTransportsRef.current.get(pane.id)
  const ptyId = transport?.getPtyId() ?? null
  const isTargetMounted = (): boolean => isPanePasteTargetMounted(context, pane, transport, ptyId)
  const execution = await pasteTextIntoTerminalPane({
    pane,
    text,
    source,
    ptyId,
    runtime: resolveTerminalPasteRuntime({
      platform: getShortcutPlatform(),
      ptyId,
      transport,
      isWindowsConpty: context.forceBracketedMultilineTextPaste
    }),
    transport,
    inputKind: 'driving',
    isTargetCurrent: isTargetMounted,
    canContinue: isTargetMounted,
    planOptions: options
  })
  if (execution.status !== 'pasted') {
    context.onPasteError(formatTerminalPasteExecutionError(execution.reason))
    return false
  }
  if (text) {
    recordTerminalUserInputForLeaf(context.tabId, pane.leafId)
  }
  if (options?.recoverImagePasteWebglAtlas) {
    scheduleImagePasteWebglAtlasRecovery()
  }
  return true
}

export const pasteTerminalPaneMenuClipboard = async (
  context: TerminalPaneMenuPasteContext,
  pane: ManagedPane | null,
  source: Extract<TerminalPasteSource, 'context-menu' | 'right-click'>
): Promise<void> => {
  if (!pane) {
    return
  }
  if (requestNativeChatCoverPaste(pane)) {
    return
  }
  const { tabId, worktreeId, forceBracketedMultilineTextPaste, onPasteError } = context
  // Only the operation that started an image upload may settle it; text pastes leave the hold alone.
  let uploadToken: ClipboardImageUploadToken | null = null
  const connectionId = getConnectionId(worktreeId) ?? null
  const state = useAppStore.getState()
  const transport = context.paneTransportsRef.current.get(pane.id) ?? null
  const runtimeEnvironmentId = resolveTerminalPasteRuntimeEnvironmentId(
    state,
    worktreeId,
    transport
  )
  const result = await pasteTerminalClipboard({
    readClipboardText: window.api.ui.readClipboardText,
    saveClipboardImageAsTempFile: window.api.ui.saveClipboardImageAsTempFile,
    copiedFiles: createTerminalClipboardCopiedFiles({
      managerRef: context.managerRef,
      paneTransportsRef: context.paneTransportsRef,
      worktreeId,
      tabId,
      cwd: context.cwd,
      pane
    }),
    connectionId,
    runtimeEnvironmentId,
    protectedMultilineTextPasteOptions: resolveProtectedMultilinePasteOptionsForPane({
      isWindowsClient: forceBracketedMultilineTextPaste,
      hostPlatform: resolveTerminalInputHostPlatform({
        clientPlatform: getShortcutPlatform(),
        state,
        worktreeId,
        transport
      }),
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey,
      tabId,
      leafId: pane.leafId
    }),
    pasteText: (text, options) =>
      executeTerminalPaneMenuPasteText(context, pane, source, text, options),
    onTextPasteError: () =>
      onPasteError('Paste failed: clipboard text is too large for a safe terminal paste.'),
    onImagePasteError: (error) => {
      const detail = error instanceof Error ? error.message : String(error)
      onPasteError(`Image paste failed: ${detail}`)
    },
    onImagePasteUploadStart: () => {
      uploadToken = context.clipboardImageEnterHold.noteImageUploadStart(pane.id)
    }
  })
  if (uploadToken) {
    context.clipboardImageEnterHold.settleImageUpload(
      uploadToken,
      result.status === 'pasted' && result.kind === 'image-path'
    )
  }
  if (result.status !== 'pasted') {
    return
  }
  // Refocus after completed paste only; a rejected async target must not steal focus from a newer control.
  pane.terminal.focus()
}
