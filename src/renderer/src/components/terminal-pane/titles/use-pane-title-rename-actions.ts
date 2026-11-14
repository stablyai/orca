import { useCallback, useEffect } from 'react'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'

export function usePaneTitleRenameActions({
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
}: Pick<
  TerminalPaneCloseController,
  | 'renamingPaneId'
  | 'renameSubmittedRef'
  | 'renameValue'
  | 'paneTitlesRef'
  | 'removePaneTitle'
  | 'closeRenameSession'
  | 'setRenamingPaneId'
  | 'changePaneTitle'
  | 'renameBlurCommitEnabledRef'
  | 'renameUserRequestedBlurCommitRef'
  | 'renameRefocusFrameRef'
  | 'renameSessionIdRef'
  | 'renameInputRef'
  | 'renameFocusFrameRef'
  | 'renameEnableBlurFrameRef'
  | 'cancelPendingRenameFrames'
>) {
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
    closeRenameSession()
    setRenamingPaneId(null)
    changePaneTitle(renamingPaneId, trimmed)
  }, [
    closeRenameSession,
    renamingPaneId,
    renameValue,
    removePaneTitle,
    changePaneTitle,
    paneTitlesRef,
    renameSubmittedRef,
    setRenamingPaneId
  ])
  const handleRenameCancel = useCallback(() => {
    renameSubmittedRef.current = true
    closeRenameSession()
    setRenamingPaneId(null)
  }, [closeRenameSession, renameSubmittedRef, setRenamingPaneId])
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
  }, [
    handleRenameSubmit,
    renamingPaneId,
    renameBlurCommitEnabledRef,
    renameInputRef,
    renameRefocusFrameRef,
    renameSessionIdRef,
    renameSubmittedRef,
    renameUserRequestedBlurCommitRef
  ])
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
  }, [
    cancelPendingRenameFrames,
    renamingPaneId,
    renameBlurCommitEnabledRef,
    renameEnableBlurFrameRef,
    renameFocusFrameRef,
    renameInputRef,
    renameSessionIdRef,
    renameSubmittedRef
  ])
  return { handleRenameSubmit, handleRenameCancel, handleRenameBlur, handleRemoveTitle }
}
