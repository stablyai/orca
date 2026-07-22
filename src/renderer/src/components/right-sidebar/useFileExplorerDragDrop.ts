/* eslint-disable max-lines -- Why: explorer drag/drop keeps move, native-file
drop, auto-expand, and undo/redo coordination in one hook because splitting the
DnD state machine across files makes those interactions harder to reason about. */
import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { basename, dirname, joinPath } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import {
  getWorkspaceFileDragRejectionMessage,
  readWorkspaceFileDragPaths,
  WORKSPACE_FILE_PATH_MIME
} from '@/lib/workspace-file-drag'
import { executeOpenEditorPathMove } from '@/lib/execute-open-editor-path-move'
import { commitFileExplorerOp } from './fileExplorerUndoRedo'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'

function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : err.message
}

type UseFileExplorerDragDropParams = {
  worktreePath: string | null
  activeWorktreeId: string | null
  expanded: Set<string>
  toggleDir: (worktreeId: string, dirPath: string) => void
  refreshDir: (dirPath: string) => Promise<void>
  // Explorer scroll viewport used to auto-scroll while dragging near top/bottom edges
  scrollRef: RefObject<HTMLDivElement | null>
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

// Native drag auto-scroll uses a very thin band; a wider zone matches IDE-style
// tree dragging so users need not hug the scrollbar.
const DRAG_EDGE_ZONE_PX = 48

export function getDragEdgeScrollTarget({
  scrollTop,
  scrollHeight,
  clientHeight,
  localY,
  edgeZonePx = DRAG_EDGE_ZONE_PX
}: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  localY: number
  edgeZonePx?: number
}): number | null {
  let delta = 0
  if (localY < edgeZonePx) {
    const strength = (edgeZonePx - localY) / edgeZonePx
    delta = -(1.25 + strength * 9)
  } else if (localY > clientHeight - edgeZonePx) {
    const strength = (localY - (clientHeight - edgeZonePx)) / edgeZonePx
    delta = 1.25 + strength * 9
  }

  if (delta === 0) {
    return null
  }

  const maxScroll = Math.max(0, scrollHeight - clientHeight)
  const nextScrollTop = Math.max(0, Math.min(maxScroll, scrollTop + delta))
  return nextScrollTop === scrollTop ? null : nextScrollTop
}

export function useFileExplorerDragDrop({
  worktreePath,
  activeWorktreeId,
  expanded,
  toggleDir,
  refreshDir,
  scrollRef
}: UseFileExplorerDragDropParams): UseFileExplorerDragDropResult {
  const [isRootDragOver, setIsRootDragOver] = useState(false)
  const rootDragCounterRef = useRef(0)
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null)
  const [dragSourcePath, setDragSourcePath] = useState<string | null>(null)

  // Native Files drag state — tracked separately from internal move state
  const [isNativeDragOver, setIsNativeDragOver] = useState(false)
  const nativeRootDragCounterRef = useRef(0)
  const [nativeDropTargetDir, setNativeDropTargetDir] = useState<string | null>(null)

  const lastDragClientYRef = useRef<number | null>(null)
  const edgeScrollRafRef = useRef<number | null>(null)

  const stopDragEdgeScroll = useCallback(() => {
    lastDragClientYRef.current = null
    if (edgeScrollRafRef.current !== null) {
      cancelAnimationFrame(edgeScrollRafRef.current)
      edgeScrollRafRef.current = null
    }
  }, [])

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

  // requestAnimationFrame + small per-frame deltas avoids choppy jumps from irregular dragover events
  const tickDragEdgeScroll = useCallback(() => {
    edgeScrollRafRef.current = null
    const viewport = scrollRef.current
    const clientY = lastDragClientYRef.current
    if (!viewport || clientY == null) {
      return
    }
    const rect = viewport.getBoundingClientRect()
    const y = clientY - rect.top
    const zone = DRAG_EDGE_ZONE_PX

    const nextScrollTop = getDragEdgeScrollTarget({
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      localY: y,
      edgeZonePx: zone
    })

    if (nextScrollTop !== null) {
      viewport.scrollTop = nextScrollTop
      edgeScrollRafRef.current = requestAnimationFrame(tickDragEdgeScroll)
    }
  }, [scrollRef])

  const handleMoveDrop = useCallback(
    (sourcePath: string, destDir: string) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      const fileName = basename(sourcePath),
        sourceDir = dirname(sourcePath)

      setDropTargetDir(null)

      if (sourceDir === destDir) {
        return
      }
      if (
        destDir === sourcePath ||
        destDir.startsWith(`${sourcePath}/`) ||
        destDir.startsWith(`${sourcePath}\\`)
      ) {
        return
      }

      const newPath = joinPath(destDir, fileName)

      const run = async (): Promise<void> => {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        const fileContext = {
          settings: getRightSidebarWorktreeRuntimeSettings(activeWorktreeId),
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        }
        // The coordinator quiesces saves, retargets the open sessions in place,
        // and settles the move as one transaction (was: quiesce + rename + remap).
        try {
          await executeOpenEditorPathMove({
            context: fileContext,
            fromPath: sourcePath,
            toPath: newPath,
            worktreeId: activeWorktreeId,
            worktreePath
          })
          commitFileExplorerOp({
            undo: async () => {
              await executeOpenEditorPathMove({
                context: fileContext,
                fromPath: newPath,
                toPath: sourcePath,
                worktreeId: activeWorktreeId,
                worktreePath
              })
              await Promise.all([refreshDir(destDir), refreshDir(sourceDir)])
            },
            redo: async () => {
              await executeOpenEditorPathMove({
                context: fileContext,
                fromPath: sourcePath,
                toPath: newPath,
                worktreeId: activeWorktreeId,
                worktreePath
              })
              await Promise.all([refreshDir(sourceDir), refreshDir(destDir)])
            }
          })
        } catch (err) {
          toast.error(extractIpcErrorMessage(err, `Failed to move '${fileName}'.`))
          return
        }
        await Promise.all([refreshDir(sourceDir), refreshDir(destDir)])
      }
      void run()
    },
    [worktreePath, activeWorktreeId, refreshDir]
  )

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
        lastDragClientYRef.current = e.clientY
        if (edgeScrollRafRef.current === null) {
          edgeScrollRafRef.current = requestAnimationFrame(tickDragEdgeScroll)
        }
      },
      [tickDragEdgeScroll]
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

  const handleDragExpandDir = useCallback(
    (dirPath: string) => {
      if (!activeWorktreeId || expanded.has(dirPath)) {
        return
      }
      toggleDir(activeWorktreeId, dirPath)
    },
    [activeWorktreeId, expanded, toggleDir]
  )

  // Why: native drag expand must be expand-only (never collapse). The preload
  // captures native drop events in the capture phase and stops propagation,
  // so React's handleDrop never fires and the expand timer is never cleared.
  // If revealInExplorer already expanded the folder before the timer fires,
  // a toggleDir call would collapse it. Reading current state at call time
  // also avoids stale-closure issues with the 500ms timer callback.
  const handleNativeDragExpandDir = useCallback(
    (dirPath: string) => {
      if (!activeWorktreeId) {
        return
      }
      useAppStore.setState((state) => {
        const current = state.expandedDirs[activeWorktreeId] ?? new Set<string>()
        if (current.has(dirPath)) {
          return state
        }
        const next = new Set(current)
        next.add(dirPath)
        return { expandedDirs: { ...state.expandedDirs, [activeWorktreeId]: next } }
      })
    },
    [activeWorktreeId]
  )
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
