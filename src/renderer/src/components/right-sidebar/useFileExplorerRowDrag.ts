import React, { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  getWorkspaceFileDragRejectionMessage,
  readWorkspaceFileDragPaths,
  WORKSPACE_FILE_PATH_MIME
} from '@/lib/workspace-file-drag'

const DRAG_EXPAND_DELAY_MS = 500

type UseFileExplorerRowDragParams = {
  rowDropDir: string
  isDirectory: boolean
  nodePath: string
  isExpanded: boolean
  onDragTargetChange: (dir: string | null) => void
  onDragExpandDir: (dirPath: string) => void
  onNativeDragTargetChange: (dir: string | null) => void
  onNativeDragExpandDir: (dirPath: string) => void
  onMoveDrop: (sourcePath: string, destDir: string) => void
}

type RowDragHandlers = {
  setRowDragNode: (node: HTMLButtonElement | null) => void
  handleDragOver: (e: React.DragEvent) => void
  handleDragEnter: (e: React.DragEvent) => void
  handleDragLeave: (e: React.DragEvent) => void
  handleDrop: (e: React.DragEvent) => void
}

export function useFileExplorerRowDrag({
  rowDropDir,
  isDirectory,
  nodePath,
  isExpanded,
  onDragTargetChange,
  onDragExpandDir,
  onNativeDragTargetChange,
  onNativeDragExpandDir,
  onMoveDrop
}: UseFileExplorerRowDragParams): RowDragHandlers {
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragCounterRef = useRef(0)
  const nativeDragCounterRef = useRef(0)
  const nativeExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearExpandTimer = useCallback(() => {
    if (expandTimerRef.current !== null) {
      clearTimeout(expandTimerRef.current)
      expandTimerRef.current = null
    }
  }, [])

  const clearNativeExpandTimer = useCallback(() => {
    if (nativeExpandTimerRef.current !== null) {
      clearTimeout(nativeExpandTimerRef.current)
      nativeExpandTimerRef.current = null
    }
  }, [])

  const setRowDragNode = useCallback(
    (node: HTMLButtonElement | null): void => {
      // Detach invalidates row-owned expand timers even if dragleave never fires.
      if (node === null) {
        clearExpandTimer()
        clearNativeExpandTimer()
      }
    },
    [clearExpandTimer, clearNativeExpandTimer]
  )

  // OS file dragover and drop are taken by the explorer root's owner before rows see them.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)) {
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      const isInternal = e.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)
      const isNative = !isInternal && e.dataTransfer.types.includes('Files')
      if (!isInternal && !isNative) {
        return
      }
      e.preventDefault()
      e.stopPropagation()

      if (isInternal) {
        dragCounterRef.current += 1
        onDragTargetChange(rowDropDir)
        if (dragCounterRef.current === 1 && isDirectory && !isExpanded) {
          clearExpandTimer()
          expandTimerRef.current = setTimeout(() => {
            expandTimerRef.current = null
            onDragExpandDir(nodePath)
          }, DRAG_EXPAND_DELAY_MS)
        }
      } else {
        nativeDragCounterRef.current += 1
        // Only directories claim row highlights; file-parent targets would highlight every sibling, so use the root fallback instead.
        onNativeDragTargetChange(isDirectory ? rowDropDir : null)
        if (nativeDragCounterRef.current === 1 && isDirectory && !isExpanded) {
          clearNativeExpandTimer()
          nativeExpandTimerRef.current = setTimeout(() => {
            nativeExpandTimerRef.current = null
            onNativeDragExpandDir(nodePath)
          }, DRAG_EXPAND_DELAY_MS)
        }
      }
    },
    [
      rowDropDir,
      onDragTargetChange,
      onNativeDragTargetChange,
      clearExpandTimer,
      clearNativeExpandTimer,
      isDirectory,
      nodePath,
      isExpanded,
      onDragExpandDir,
      onNativeDragExpandDir
    ]
  )

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation()
      dragCounterRef.current -= 1
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0
        clearExpandTimer()
      }
      // Some browsers clear types on dragleave; decrement both counters and clamp against drift.
      nativeDragCounterRef.current -= 1
      if (nativeDragCounterRef.current <= 0) {
        nativeDragCounterRef.current = 0
        clearNativeExpandTimer()
        // Moving to the root background emits no row target update; clear the old highlight here.
        onNativeDragTargetChange(null)
      }
    },
    [clearExpandTimer, clearNativeExpandTimer, onNativeDragTargetChange]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current = 0
      nativeDragCounterRef.current = 0
      clearExpandTimer()
      clearNativeExpandTimer()
      onDragTargetChange(null)
      onNativeDragTargetChange(null)
      const dragPaths = readWorkspaceFileDragPaths(e.dataTransfer)
      if (dragPaths.status === 'rejected') {
        toast.error(getWorkspaceFileDragRejectionMessage(dragPaths.reason))
        return
      }
      for (const sourcePath of dragPaths.paths) {
        onMoveDrop(sourcePath, rowDropDir)
      }
    },
    [
      rowDropDir,
      onMoveDrop,
      onDragTargetChange,
      onNativeDragTargetChange,
      clearExpandTimer,
      clearNativeExpandTimer
    ]
  )

  return { setRowDragNode, handleDragOver, handleDragEnter, handleDragLeave, handleDrop }
}
