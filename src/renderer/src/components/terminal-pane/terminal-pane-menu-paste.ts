import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { requestNativeChatCoverPaste } from './native-chat-cover-paste'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import type { TerminalPasteSource, TerminalPasteTextOptions } from './terminal-paste-coordinator'
import { formatTerminalPasteExecutionError } from './terminal-paste-errors'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import { isTerminalPanePasteTargetCurrent } from './terminal-paste-target-state'
import { pasteTextIntoTerminalPane } from './terminal-pane-paste-dispatch'
import { scheduleImagePasteWebglAtlasRecovery } from './terminal-webgl-atlas-recovery'
import { useAppStore } from '@/store'
import { resolveProtectedMultilinePasteOptionsForPane } from './terminal-agent-paste-bracketing'
import { resolveTerminalInputHostPlatform } from './terminal-input-host-platform'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'

export type TerminalPaneMenuPasteContext = {
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  tabId: string
  worktreeId: string
  forceBracketedMultilineTextPaste: boolean
  onPasteError: (message: string) => void
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
  const connectionId = getConnectionId(context.worktreeId) ?? null
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
      connectionId,
      remotePlatform: getTerminalPasteSshRemotePlatform(connectionId),
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
  const connectionId = getConnectionId(worktreeId) ?? null
  const state = useAppStore.getState()
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  const transport = context.paneTransportsRef.current.get(pane.id) ?? null
  const result = await pasteTerminalClipboard({
    readClipboardText: window.api.ui.readClipboardText,
    saveClipboardImageAsTempFile: window.api.ui.saveClipboardImageAsTempFile,
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
    }
  })
  if (result.status !== 'pasted') {
    return
  }
  // Why: Radix returns focus to the menu trigger (the pane container) on
  // close. Refocus only after a completed paste so rejected async targets
  // do not steal focus from the user's new control.
  pane.terminal.focus()
}
