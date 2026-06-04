import React, { useCallback, useRef } from 'react'
import { getWorkspaceFileDragPaths, WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'

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
      // Why: delayed drag-expand timers target this row; unmounting the row
      // makes those timers stale even if the browser skips dragleave.
      if (node === null) {
        clearExpandTimer()
        clearNativeExpandTimer()
      }
    },
    [clearExpandTimer, clearNativeExpandTimer]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    const isInternal = e.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)
    const isNative = e.dataTransfer.types.includes('Files')
    if (!isInternal && !isNative) {
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = isInternal ? 'move' : 'copy'
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
        // Why: only directories should claim themselves as native drop targets.
        // A file row's parent dir (rowDropDir) would highlight every sibling,
        // which is misleading when the user is aiming for a specific folder.
        // Clearing the target for files lets the root container's subtle
        // bg-border indicate the fallback drop zone instead.
        onNativeDragTargetChange(isDirectory ? rowDropDir : null)
        // Reuse the same auto-expand delay for native drags over directories
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
      // Decrement both counters since we cannot inspect types on dragleave
      // (dataTransfer.types is empty in some browsers during dragleave).
      // The clamp-to-zero prevents negative drift.
      nativeDragCounterRef.current -= 1
      if (nativeDragCounterRef.current <= 0) {
        nativeDragCounterRef.current = 0
        clearNativeExpandTimer()
        // Why: clear stale row highlight so moving from a row to the root
        // background (which has no row-level nativeDragTargetChange) does not
        // leave the previous row visually highlighted.
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
      for (const sourcePath of getWorkspaceFileDragPaths(e.dataTransfer)) {
        onMoveDrop(sourcePath, rowDropDir)
      }
      // Why: native Files drops are handled by the preload-relayed IPC event,
      // not the React drop handler. We only clear visual state here.
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
