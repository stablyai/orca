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
  displayRootPath?: string | null
  activeWorktreeId: string | null
  expanded: Set<string>
  toggleDir: (worktreeId: string, dirPath: string) => void
  refreshDir: (dirPath: string) => Promise<void>
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
  isNativeDragOver: boolean
  nativeDropTargetDir: string | null
  setNativeDropTargetDir: (dir: string | null) => void
  handleNativeDragExpandDir: (dirPath: string) => void
  // Stops the drag edge auto-scroll loop (call on drag end / unmount)
  stopDragEdgeScroll: () => void
  rootDragHandlers: {
    onDragOverCapture: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDragEnter: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
  /** Clears all native drag visual state (call after import completes) */
  clearNativeDragState: () => void
}

/** Routes background drops to the displayed directory while preserving the worktree context for move operations. */
export function useFileExplorerDragDrop({
  worktreePath,
  displayRootPath = worktreePath,
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
      // Capture document-level finishes: OS-drop owners stop bubbling, and rejected/cancelled/outside drops must stop edge scrolling.
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
    // OS-drop ownership bypasses React onDrop; stop its self-rescheduling scroll loop here.
    stopAndClearDragState()
  }, [stopAndClearDragState])

  const rootDragHandlers = {
    // Capture before the OS-drop owner stops dragover propagation.
    onDragOverCapture: useCallback(
      (e: React.DragEvent) => {
        const types = e.dataTransfer.types
        if (types.includes(WORKSPACE_FILE_PATH_MIME) || types.includes('Files')) {
          startDragEdgeScroll(e.clientY)
        }
      },
      [startDragEdgeScroll]
    ),
    // OS file drags never reach here; the explorer's OS-drop owner sets their drop effect.
    onDragOver: useCallback((e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)) {
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    }, []),
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
        // dragleave cannot reliably identify types, so decrement both counters.
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
        // Leaving can skip onDrop/onDragEnd; stop the self-rescheduling rAF loop before it fights manual scrolling.
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
        clearNativeDragState()
        if (displayRootPath) {
          const dragPaths = readWorkspaceFileDragPaths(e.dataTransfer)
          if (dragPaths.status === 'rejected') {
            toast.error(getWorkspaceFileDragRejectionMessage(dragPaths.reason))
            return
          }
          for (const sourcePath of dragPaths.paths) {
            handleMoveDrop(sourcePath, displayRootPath)
          }
        }
      },
      [displayRootPath, handleMoveDrop, stopDragEdgeScroll, clearNativeDragState]
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
