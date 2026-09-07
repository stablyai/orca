import { useCallback, useEffect, useMemo } from 'react'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'
import { useTerminalQuickCommandHosts } from '@/hooks/use-terminal-quick-command-hosts'
import { terminalQuickCommandMatchesWorkspaceProject } from '@/lib/terminal-quick-command-project-scope'
import {
  getTerminalQuickCommandScope,
  isTerminalQuickCommandComplete
} from '../../../../shared/terminal-quick-commands'

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
    persistLayoutSnapshot,
    quickCommandGroupId,
    quickCommandRepoId,
    projectHostSetupProjection,
    removePaneTitle,
    removedTitleLeafIdsRef,
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
    setPaneTitles,
    setRenamingPaneId,
    setTerminalError,
    tabId,
    toggleExpandPane,
    worktreeId
  } = controller

  const handleRenameSubmit = useCallback(() => {
    if (renamingPaneId === null || renameSubmittedRef.current) {
      return
    }
    renameSubmittedRef.current = true
    const trimmed = renameValue.trim()
    if (trimmed.length === 0) {
      if (paneTitlesRef.current[renamingPaneId]) {
        removePaneTitle(renamingPaneId)
      }
      closeRenameSession()
      setRenamingPaneId(null)
      return
    }
    setPaneTitles((previous) => ({ ...previous, [renamingPaneId]: trimmed }))
    paneTitlesRef.current = { ...paneTitlesRef.current, [renamingPaneId]: trimmed }
    const leafId = managerRef.current?.getPanes().find((pane) => pane.id === renamingPaneId)?.leafId
    if (leafId) {
      removedTitleLeafIdsRef.current.delete(leafId)
    }
    closeRenameSession()
    setRenamingPaneId(null)
    persistLayoutSnapshot()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [closeRenameSession, renamingPaneId, renameValue, removePaneTitle, persistLayoutSnapshot])
  const handleRenameCancel = useCallback(() => {
    renameSubmittedRef.current = true
    closeRenameSession()
    setRenamingPaneId(null)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [closeRenameSession])
  const handleRenameBlur = useCallback(() => {
    if (renameSubmittedRef.current) {
      return
    }
    if (renameBlurCommitEnabledRef.current && renameUserRequestedBlurCommitRef.current) {
      handleRenameSubmit()
      return
    }
    if (renamingPaneId === null || renameRefocusFrameRef.current !== null) {
      return
    }
    const sessionId = renameSessionIdRef.current
    const paneId = renamingPaneId
    renameRefocusFrameRef.current = requestAnimationFrame(() => {
      renameRefocusFrameRef.current = null
      if (renameSessionIdRef.current !== sessionId || renamingPaneId !== paneId) {
        return
      }
      const input = renameInputRef.current
      if (!input) {
        renameBlurCommitEnabledRef.current = true
        return
      }
      input.focus()
      input.select()
      renameBlurCommitEnabledRef.current = true
    })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [handleRenameSubmit, renamingPaneId])
  const handleRemoveTitle = useCallback(
    (paneId: number) => removePaneTitle(paneId),
    [removePaneTitle]
  )

  useEffect(() => {
    if (renamingPaneId === null) {
      return
    }
    const sessionId = renameSessionIdRef.current
    const paneId = renamingPaneId
    renameSubmittedRef.current = false
    renameFocusFrameRef.current = requestAnimationFrame(() => {
      renameFocusFrameRef.current = null
      if (renameSessionIdRef.current !== sessionId || renamingPaneId !== paneId) {
        return
      }
      const input = renameInputRef.current
      if (!input) {
        return
      }
      input.focus()
      input.select()
      renameEnableBlurFrameRef.current = requestAnimationFrame(() => {
        renameEnableBlurFrameRef.current = null
        if (
          renameSessionIdRef.current === sessionId &&
          renamingPaneId === paneId &&
          renameInputRef.current === input &&
          document.activeElement === input
        ) {
          renameBlurCommitEnabledRef.current = true
        }
      })
    })
    return () => cancelPendingRenameFrames()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [cancelPendingRenameFrames, renamingPaneId])

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
  const visibleQuickCommandHosts = useMemo(
    () =>
      quickCommandHosts.map((host) => {
        const commands = host.commands.filter(isTerminalQuickCommandComplete)
        return {
          globalCommands: commands.filter(
            (command) => getTerminalQuickCommandScope(command).type === 'global'
          ),
          hostId: host.hostId,
          label: host.label,
          repoCommands: commands.filter((command) => {
            const scope = getTerminalQuickCommandScope(command)
            return (
              scope.type === 'repo' &&
              terminalQuickCommandMatchesWorkspaceProject(command, {
                commandHostId: host.hostId,
                projectHostSetups: projectHostSetupProjection.setups,
                targetHostId: quickCommandExecutionHostId,
                targetRepoId: quickCommandRepoId
              })
            )
          })
        }
      }),
    [
      projectHostSetupProjection.setups,
      quickCommandExecutionHostId,
      quickCommandHosts,
      quickCommandRepoId
    ]
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [contextMenu.menuPaneId])
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
