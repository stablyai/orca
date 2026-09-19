import { useCallback, useRef, useState } from 'react'
import type { PaneTitleOverlayRect } from './TerminalPaneHeaderOverlay'
import {
  createRemotePaneLayoutPusher,
  type RemotePaneLayoutPusher
} from './remote-pane-layout-push'
import { isTerminalSessionStateSaveFailure } from '../../../../shared/terminal-session-state-save-failure'
import { appendPaneTerminalError, clearPaneTerminalError } from './terminal-error-accumulation'
import { stripSshReconnectOwnedErrorLines } from './TerminalErrorToast'
import { updateTerminalRemoteRuntimeRecoveryUiState } from './terminal-remote-runtime-recovery-ui-state'
import type { PtyTransportRecoveryState } from './pty-transport-types'
import type { TerminalPaneFoundation } from './use-terminal-pane-foundation'

export function useTerminalPaneTitleState(controller: TerminalPaneFoundation) {
  const {
    containerRef,
    managerRef,
    paneTransportsRef,
    setPtyRecoveryStatesByPaneId,
    setSessionStateSaveFailureOpen,
    setTerminalError,
    setTerminalErrorsByPaneId,
    sshReconnectOwnsTerminalErrorsRef
  } = controller
  const [paneTitles, setPaneTitles] = useState<Record<number, string>>({})
  const paneTitlesRef = useRef<Record<number, string>>({})
  // Rename handlers read this ref synchronously during the render that changes it.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  paneTitlesRef.current = paneTitles
  const removedTitleLeafIdsRef = useRef<Set<string>>(new Set())
  const clearedScrollbackLeafIdsRef = useRef<Set<string>>(new Set())
  const remotePaneLayoutPusherRef = useRef<RemotePaneLayoutPusher | null>(null)
  remotePaneLayoutPusherRef.current ??= createRemotePaneLayoutPusher()
  const [paneTitleOverlayRects, setPaneTitleOverlayRects] = useState<
    Record<number, PaneTitleOverlayRect>
  >({})
  const [renamingPaneId, setRenamingPaneId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameSubmittedRef = useRef(false)
  const renameSessionIdRef = useRef(0)
  const renameBlurCommitEnabledRef = useRef(true)
  const renameUserRequestedBlurCommitRef = useRef(false)
  const renameFocusFrameRef = useRef<number | null>(null)
  const renameEnableBlurFrameRef = useRef<number | null>(null)
  const renameRefocusFrameRef = useRef<number | null>(null)
  const cancelPendingRenameFrames = useCallback(() => {
    const frameRefs = [renameFocusFrameRef, renameEnableBlurFrameRef, renameRefocusFrameRef]
    for (const frameRef of frameRefs) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [])

  const closeRenameSession = useCallback(() => {
    renameSessionIdRef.current += 1
    renameBlurCommitEnabledRef.current = true
    renameUserRequestedBlurCommitRef.current = false
    cancelPendingRenameFrames()
  }, [cancelPendingRenameFrames])

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null): void => {
      containerRef.current = node
      if (node !== null) {
        return
      }
      closeRenameSession()
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [closeRenameSession]
  )

  const handleStartRename = useCallback(
    (paneId: number) => {
      cancelPendingRenameFrames()
      renameSessionIdRef.current += 1
      renameBlurCommitEnabledRef.current = false
      renameUserRequestedBlurCommitRef.current = false
      renameSubmittedRef.current = false
      setRenameValue(paneTitlesRef.current[paneId] ?? '')
      setRenamingPaneId(paneId)
    },
    [cancelPendingRenameFrames]
  )
  const onPtyErrorRef = useRef((paneId: number, message: string) => {
    if (isTerminalSessionStateSaveFailure(message)) {
      setTerminalError(null)
      setTerminalErrorsByPaneId({})
      setSessionStateSaveFailureOpen(true)
      return
    }
    const visibleMessage = sshReconnectOwnsTerminalErrorsRef.current
      ? stripSshReconnectOwnedErrorLines(message)
      : message
    if (visibleMessage !== null) {
      setTerminalErrorsByPaneId((current) =>
        appendPaneTerminalError(current, paneId, visibleMessage)
      )
    }
  })
  const onPtyErrorClearedRef = useRef((paneId: number, message?: string) => {
    setTerminalErrorsByPaneId((current) => clearPaneTerminalError(current, paneId, message))
  })
  const dismissTerminalError = useCallback(() => {
    const paneId = managerRef.current?.getActivePane()?.id ?? null
    setTerminalError(null)
    if (paneId !== null) {
      setTerminalErrorsByPaneId((current) => clearPaneTerminalError(current, paneId))
      paneTransportsRef.current.get(paneId)?.notifyErrorSurfaceDismissed?.()
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [])
  const onPtyRecoveryStateRef = useRef(
    (paneId: number, state: PtyTransportRecoveryState | null) => {
      setPtyRecoveryStatesByPaneId((previous) =>
        updateTerminalRemoteRuntimeRecoveryUiState(previous, paneId, state)
      )
    }
  )

  return {
    paneTitles,
    setPaneTitles,
    paneTitlesRef,
    removedTitleLeafIdsRef,
    clearedScrollbackLeafIdsRef,
    remotePaneLayoutPusherRef,
    paneTitleOverlayRects,
    setPaneTitleOverlayRects,
    renamingPaneId,
    setRenamingPaneId,
    renameValue,
    setRenameValue,
    renameInputRef,
    renameSubmittedRef,
    renameSessionIdRef,
    renameBlurCommitEnabledRef,
    renameUserRequestedBlurCommitRef,
    renameFocusFrameRef,
    renameEnableBlurFrameRef,
    renameRefocusFrameRef,
    cancelPendingRenameFrames,
    closeRenameSession,
    setContainerRef,
    handleStartRename,
    onPtyErrorRef,
    onPtyErrorClearedRef,
    dismissTerminalError,
    onPtyRecoveryStateRef
  }
}

export type TerminalPaneTitleController = TerminalPaneFoundation &
  ReturnType<typeof useTerminalPaneTitleState>
