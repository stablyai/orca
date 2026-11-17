import { usePaneTitleRenameActions } from '../titles/use-pane-title-rename-actions'
import { useCallback, useEffect } from 'react'
import { useTerminalPaneContextMenu } from '../context-menu/use-terminal-pane-context-menu'
import type { TerminalPaneMountedController } from '../mounting/use-terminal-pane-lifecycle-stage'
import type { UseTerminalPaneContextMenuDeps } from '../context-menu/terminal-pane-context-menu-types'
import { useTerminalQuickCommandHosts } from '@/hooks/use-terminal-quick-command-hosts'
import { useVisibleTerminalQuickCommandHosts } from '@/hooks/use-visible-terminal-quick-command-hosts'

/** The paste listeners attach the shared image-paste Enter hold to the controller before this hook runs. */
type TerminalPaneContextActionsController = TerminalPaneMountedController &
  Pick<UseTerminalPaneContextMenuDeps, 'clipboardImageEnterHold'>

export function useTerminalPaneContextActions(controller: TerminalPaneContextActionsController) {
  const {
    cancelPendingRenameFrames,
    clearPaneScrollback,
    closeRenameSession,
    containerRef,
    cwd,
    forceBracketedMultilineTextPaste,
    handleClearPaneTitleShortcut,
    handleRequestClosePane,
    handleStartRename,
    managerRef,
    paneCwdRef,
    paneTitlesRef,
    paneTransportsRef,
    quickCommandGroupId,
    quickCommandRepoId,
    removePaneTitle,
    changePaneTitle,
    renameBlurCommitEnabledRef,
    renameEnableBlurFrameRef,
    renameFocusFrameRef,
    renameInputRef,
    renameRefocusFrameRef,
    renameSessionIdRef,
    renameSubmittedRef,
    renameUserRequestedBlurCommitRef,
    renameValue,
    renamingPaneId,
    rightClickToPaste,
    clipboardImageEnterHold,
    setAgentSessionContinuation,
    setAgentSessionFork,
    setRenamingPaneId,
    setTerminalError,
    tabId,
    toggleExpandPane,
    worktreeId
  } = controller
  const { handleRenameSubmit, handleRenameCancel, handleRenameBlur, handleRemoveTitle } =
    usePaneTitleRenameActions({
      renamingPaneId,
      renameSubmittedRef,
      renameValue,
      paneTitlesRef,
      removePaneTitle,
      closeRenameSession,
      setRenamingPaneId,
      changePaneTitle,
      renameBlurCommitEnabledRef,
      renameUserRequestedBlurCommitRef,
      renameRefocusFrameRef,
      renameSessionIdRef,
      renameInputRef,
      renameFocusFrameRef,
      renameEnableBlurFrameRef,
      cancelPendingRenameFrames
    })

  const contextMenu = useTerminalPaneContextMenu({
    tabId,
    managerRef,
    paneTransportsRef,
    paneCwdRef,
    containerRef,
    worktreeId,
    groupId: quickCommandGroupId,
    fallbackCwd: cwd ?? '',
    toggleExpandPane,
    onRequestClosePane: handleRequestClosePane,
    onClearPaneScrollback: clearPaneScrollback,
    onSetTitle: handleStartRename,
    onClearPaneTitle: handleClearPaneTitleShortcut,
    onPasteError: setTerminalError,
    onAgentSessionForkReady: setAgentSessionFork,
    onAgentSessionContinuationReady: setAgentSessionContinuation,
    forceBracketedMultilineTextPaste,
    rightClickToPaste,
    clipboardImageEnterHold
  })
  const {
    executionHostId: quickCommandExecutionHostId,
    hosts: quickCommandHosts,
    refreshRemoteHost: refreshQuickCommandRemoteHost,
    remoteHostLoadFailed: quickCommandHostLoadFailed,
    remoteHostPending: quickCommandHostOwnershipPending
  } = useTerminalQuickCommandHosts(worktreeId, contextMenu.open)
  const visibleQuickCommandHosts = useVisibleTerminalQuickCommandHosts(
    quickCommandHosts,
    quickCommandExecutionHostId,
    quickCommandRepoId
  )
  useEffect(() => {
    if (contextMenu.open) {
      refreshQuickCommandRemoteHost()
    }
  }, [contextMenu.open, refreshQuickCommandRemoteHost])
  const getContextMenuLeafId = useCallback((): string | null => {
    const paneId = contextMenu.menuPaneId
    const manager = managerRef.current
    if (!manager) {
      return null
    }
    if (paneId !== null) {
      return manager.getPanes().find((pane) => pane.id === paneId)?.leafId ?? null
    }
    return manager.getActivePane()?.leafId ?? null
  }, [contextMenu.menuPaneId, managerRef])
  const contextMenuLeafId = getContextMenuLeafId()

  return {
    handleRenameSubmit,
    handleRenameCancel,
    handleRenameBlur,
    handleRemoveTitle,
    contextMenu,
    refreshQuickCommandRemoteHost,
    quickCommandHostLoadFailed,
    quickCommandHostOwnershipPending,
    visibleQuickCommandHosts,
    getContextMenuLeafId,
    contextMenuLeafId
  }
}

export type TerminalPaneContextController = TerminalPaneMountedController &
  ReturnType<typeof useTerminalPaneContextActions>
