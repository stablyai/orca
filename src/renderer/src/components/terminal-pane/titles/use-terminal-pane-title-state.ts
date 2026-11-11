import { useTerminalPaneErrorCallbacks } from '../errors/use-terminal-pane-error-callbacks'
import { useTerminalPaneRecoveryCallback } from '../pty-transport/recovery/use-terminal-pane-recovery-callback'
import { useCallback, useRef, useState } from 'react'
import type { PaneTitleOverlayRect } from './pane-title-overlay-rects'
import {
  createRemotePaneLayoutPusher,
  type RemotePaneLayoutPusher
} from '../layout/persistence/remote-pane-layout-push'
import type { TerminalPaneFoundation } from '../controller/use-terminal-pane-foundation'

export function useTerminalPaneTitleState(controller: TerminalPaneFoundation) {
  const {
    containerRef,
    managerRef,
    paneTransportsRef,
    setPtyRecoveryStatesByPaneId,
    setSessionStateSaveFailureMessage,
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
    [closeRenameSession, containerRef]
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
  const { onPtyErrorRef, onPtyErrorClearedRef, dismissTerminalError } =
    useTerminalPaneErrorCallbacks({
      managerRef,
      paneTransportsRef,
      setSessionStateSaveFailureMessage,
      setTerminalError,
      setTerminalErrorsByPaneId,
      sshReconnectOwnsTerminalErrorsRef
    })
  const { onPtyRecoveryStateRef } = useTerminalPaneRecoveryCallback({
    setPtyRecoveryStatesByPaneId
  })

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
