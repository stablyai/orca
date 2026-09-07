import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  getWorkspaceFileDragRejectionMessage,
  readWorkspaceFileDragPaths,
  WORKSPACE_FILE_PATH_MIME
} from '@/lib/workspace-file-drag'
import type { FileExplorerOperationOwner } from './file-explorer-types'
import { useFileExplorerDragEdgeScroll } from './useFileExplorerDragEdgeScroll'
import { useFileExplorerMoveDrop } from './useFileExplorerMoveDrop'
import { useFileExplorerDragExpand } from './useFileExplorerDragExpand'

type UseFileExplorerDragDropParams = {
  worktreePath: string | null
  activeWorktreeId: string | null
  expanded: Set<string>
  toggleDir: (worktreeId: string, dirPath: string) => void
  refreshDir: (dirPath: string) => Promise<void>
  // Explorer scroll viewport used to auto-scroll while dragging near top/bottom edges
  scrollRef: RefObject<HTMLDivElement | null>
  getOperationOwnerForPath: (path: string) => FileExplorerOperationOwner | undefined
}

type UseFileExplorerDragDropResult = {
  handleMoveDrop: (sourcePath: string, destDir: string) => void
  handleDragExpandDir: (dirPath: string) => void
  dropTargetDir: string | null
  setDropTargetDir: (dir: string | null) => void
  dragSourcePath: string | null
  setDragSourcePath: (path: string | null) => void
  isRootDragOver: boolean
  /** True when a native OS file drag (Files) is hovering over the explorer */
  isNativeDragOver: boolean
  /** Directory path highlighted during a native Files drag, or null */
  nativeDropTargetDir: string | null
  setNativeDropTargetDir: (dir: string | null) => void
  handleNativeDragExpandDir: (dirPath: string) => void
  // Stops the drag edge auto-scroll loop (call on drag end / unmount)
  stopDragEdgeScroll: () => void
  rootDragHandlers: {
    onDragOver: (e: React.DragEvent) => void
    onDragEnter: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
  /** Clears all native drag visual state (call after import completes) */
  clearNativeDragState: () => void
}

export function useFileExplorerDragDrop({
  worktreePath,
  activeWorktreeId,
  expanded,
  toggleDir,
  refreshDir,
  scrollRef,
  getOperationOwnerForPath
}: UseFileExplorerDragDropParams): UseFileExplorerDragDropResult {
  const [isRootDragOver, setIsRootDragOver] = useState(false)
  const rootDragCounterRef = useRef(0)
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null)
  const [dragSourcePath, setDragSourcePath] = useState<string | null>(null)

  // Native Files drag state — tracked separately from internal move state
  const [isNativeDragOver, setIsNativeDragOver] = useState(false)
  const nativeRootDragCounterRef = useRef(0)
  const [nativeDropTargetDir, setNativeDropTargetDir] = useState<string | null>(null)

  const { startDragEdgeScroll, stopDragEdgeScroll } = useFileExplorerDragEdgeScroll(scrollRef)

  const clearDragState = useCallback(() => {
    rootDragCounterRef.current = 0
    nativeRootDragCounterRef.current = 0
    setIsRootDragOver(false)
    setDropTargetDir(null)
    setDragSourcePath(null)
    setIsNativeDragOver(false)
    setNativeDropTargetDir(null)
  }, [])

  const stopAndClearDragState = useCallback(() => {
    clearDragState()
    stopDragEdgeScroll()
  }, [clearDragState, stopDragEdgeScroll])

  useEffect(() => {
    const handleGlobalDragFinish = (): void => {
      // Why: native OS drops are consumed by preload in the capture phase, so
      // React root onDrop may never run. A document-level capture listener keeps
      // the edge-scroll loop from surviving rejected, cancelled, or row drops.
      stopAndClearDragState()
    }

    document.addEventListener('drop', handleGlobalDragFinish, true)
    document.addEventListener('dragend', handleGlobalDragFinish, true)
    window.addEventListener('blur', handleGlobalDragFinish)

    return () => {
      stopDragEdgeScroll()
      document.removeEventListener('drop', handleGlobalDragFinish, true)
      document.removeEventListener('dragend', handleGlobalDragFinish, true)
      window.removeEventListener('blur', handleGlobalDragFinish)
    }
  }, [stopAndClearDragState, stopDragEdgeScroll])

  const handleMoveDrop = useFileExplorerMoveDrop({
    worktreePath,
    activeWorktreeId,
    refreshDir,
    getOperationOwnerForPath,
    setDropTargetDir
  })

  const clearNativeDragState = useCallback(() => {
    // Why: for native OS file drops the preload intercepts the drop event and
    // stops propagation, so React's onDrop (which calls stopDragEdgeScroll)
    // never fires. Without this, the edge-scroll rAF loop keeps running with
    // the last recorded cursor Y, continuously overriding the user's scroll.
    stopAndClearDragState()
  }, [stopAndClearDragState])

  const rootDragHandlers = {
    onDragOver: useCallback(
      (e: React.DragEvent) => {
        const isInternal = e.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)
        const isNative = e.dataTransfer.types.includes('Files')
        if (!isInternal && !isNative) {
          return
        }
        e.preventDefault()
        e.dataTransfer.dropEffect = isInternal ? 'move' : 'copy'
        startDragEdgeScroll(e.clientY)
      },
      [startDragEdgeScroll]
    ),
    onDragEnter: useCallback((e: React.DragEvent) => {
      const isInternal = e.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)
      const isNative = !isInternal && e.dataTransfer.types.includes('Files')
      if (!isInternal && !isNative) {
        return
      }
      e.preventDefault()
      if (isInternal) {
        rootDragCounterRef.current += 1
        setIsRootDragOver(true)
      } else {
        nativeRootDragCounterRef.current += 1
        setIsNativeDragOver(true)
      }
    }, []),
    onDragLeave: useCallback(
      (_e: React.DragEvent) => {
        // Decrement both counters since we cannot inspect types on dragleave
        rootDragCounterRef.current -= 1
        if (rootDragCounterRef.current <= 0) {
          rootDragCounterRef.current = 0
          setIsRootDragOver(false)
        }
        nativeRootDragCounterRef.current -= 1
        if (nativeRootDragCounterRef.current <= 0) {
          nativeRootDragCounterRef.current = 0
          setIsNativeDragOver(false)
        }
        // Why: the edge auto-scroll rAF loop re-schedules itself as long as the
        // last recorded cursor Y sits in an edge zone. If the drag leaves the
        // explorer (dragged out of window, ESC-cancelled, or dropped elsewhere)
        // neither onDrop nor onDragEnd fires here, so without this stop the
        // loop keeps scrolling the viewport down and fights manual scroll-up.
        if (rootDragCounterRef.current === 0 && nativeRootDragCounterRef.current === 0) {
          stopDragEdgeScroll()
        }
      },
      [stopDragEdgeScroll]
    ),
    onDrop: useCallback(
      (e: React.DragEvent) => {
        e.preventDefault()
        stopDragEdgeScroll()
        rootDragCounterRef.current = 0
        setIsRootDragOver(false)
        setDropTargetDir(null)
        // Why: native Files drops are handled by the preload-relayed IPC event,
        // not the React drop handler. We only clear native drag visual state
        // here; the actual import is triggered from onFileDrop.
        clearNativeDragState()
        if (worktreePath) {
          const dragPaths = readWorkspaceFileDragPaths(e.dataTransfer)
          if (dragPaths.status === 'rejected') {
            toast.error(getWorkspaceFileDragRejectionMessage(dragPaths.reason))
            return
          }
          for (const sourcePath of dragPaths.paths) {
            handleMoveDrop(sourcePath, worktreePath)
          }
        }
      },
      [worktreePath, handleMoveDrop, stopDragEdgeScroll, clearNativeDragState]
    )
  }

  const { handleDragExpandDir, handleNativeDragExpandDir } = useFileExplorerDragExpand({
    activeWorktreeId,
    expanded,
    toggleDir
  })
  return {
    handleMoveDrop,
    handleDragExpandDir,
    dropTargetDir,
    setDropTargetDir,
    dragSourcePath,
    setDragSourcePath,
    isRootDragOver,
    isNativeDragOver,
    nativeDropTargetDir,
    setNativeDropTargetDir,
    handleNativeDragExpandDir,
    stopDragEdgeScroll,
    rootDragHandlers,
    clearNativeDragState
  }
}
