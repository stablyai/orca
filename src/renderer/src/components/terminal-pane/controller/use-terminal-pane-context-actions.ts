import { usePaneTitleRenameActions } from '../titles/use-pane-title-rename-actions'
import { useCallback, useEffect } from 'react'
import { useTerminalPaneContextMenu } from '../context-menu/use-terminal-pane-context-menu'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'
import { useTerminalQuickCommandHosts } from '@/hooks/use-terminal-quick-command-hosts'
import { useVisibleTerminalQuickCommandHosts } from '@/hooks/use-visible-terminal-quick-command-hosts'

export function useTerminalPaneContextActions(controller: TerminalPaneCloseController) {
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
    rightClickToPaste
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

export type TerminalPaneContextController = TerminalPaneCloseController &
  ReturnType<typeof useTerminalPaneContextActions>
