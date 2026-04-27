/* eslint-disable max-lines -- Why: explorer drag/drop keeps move, native-file
drop, auto-expand, and undo/redo coordination in one hook because splitting the
DnD state machine across files makes those interactions harder to reason about. */
import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { basename, dirname, joinPath } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import { getConnectionId } from '@/lib/connection-context'
import { requestEditorSaveQuiesce } from '@/components/editor/editor-autosave'
import { commitFileExplorerOp } from './fileExplorerUndoRedo'

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

const ORCA_PATH_MIME = 'text/x-orca-file-path'

// Native drag auto-scroll uses a very thin band; a wider zone matches IDE-style
// tree dragging so users need not hug the scrollbar.
const DRAG_EDGE_ZONE_PX = 48

export function useFileExplorerDragDrop({
  worktreePath,
  activeWorktreeId,
  expanded,
  toggleDir,
  refreshDir,
  scrollRef
}: UseFileExplorerDragDropParams): UseFileExplorerDragDropResult {
  const openFiles = useAppStore((s) => s.openFiles)

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

  useEffect(() => () => stopDragEdgeScroll(), [stopDragEdgeScroll])

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
    const h = rect.height
    const zone = DRAG_EDGE_ZONE_PX

    let delta = 0
    if (y < zone) {
      const strength = (zone - y) / zone
      delta = -(1.25 + strength * 9)
    } else if (y > h - zone) {
      const strength = (y - (h - zone)) / zone
      delta = 1.25 + strength * 9
    }

    if (delta !== 0) {
      const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      viewport.scrollTop = Math.max(0, Math.min(maxScroll, viewport.scrollTop + delta))
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
      const remapOpenTabsForMovedPath = (fromPath: string, toPath: string): void => {
        const state = useAppStore.getState()
        const filesToMove = state.openFiles.filter((file) => {
          if (file.filePath === fromPath) {
            return true
          }
          return (
            file.filePath.startsWith(`${fromPath}/`) || file.filePath.startsWith(`${fromPath}\\`)
          )
        })
        // Why: OpenFile.id === absolute path, so moves must close/reopen tabs to migrate
        // draft/dirty metadata to the new key (forward move and undo/redo parity).
        for (const file of filesToMove) {
          const oldFilePath = file.filePath
          const suffix = oldFilePath.slice(fromPath.length)
          const updatedPath = toPath + suffix
          const updatedRelative = updatedPath.slice(worktreePath.length + 1)
          const draft = state.editorDrafts[file.id]
          const wasDirty = file.isDirty

          // Why: markdown preview tabs use a synthetic tab id rather than the
          // file path, so move remaps must close the actual tab id before
          // reopening the file at its new path.
          state.closeFile(file.id)

          if (file.mode === 'edit') {
            state.openFile({
              filePath: updatedPath,
              relativePath: updatedRelative,
              worktreeId: file.worktreeId,
              language: detectLanguage(basename(updatedPath)),
              mode: 'edit'
            })
          } else if (file.mode === 'markdown-preview') {
            state.openMarkdownPreview(
              {
                filePath: updatedPath,
                relativePath: updatedRelative,
                worktreeId: file.worktreeId,
                language: 'markdown'
              },
              { anchor: file.markdownPreviewAnchor ?? null }
            )
          } else {
            continue
          }

          if (draft !== undefined) {
            state.setEditorDraft(updatedPath, draft)
          }
          if (wasDirty) {
            state.markFileDirty(updatedPath, true)
          }
        }
      }

      const run = async (): Promise<void> => {
        const filesToMove = openFiles.filter((file) => {
          if (file.filePath === sourcePath) {
            return true
          }
          return (
            file.filePath.startsWith(`${sourcePath}/`) ||
            file.filePath.startsWith(`${sourcePath}\\`)
          )
        })

        // Why: a file move changes the write target path. Let any in-flight
        // autosave settle first, then carry draft state forward to the new tab
        // id so explorer drag-and-drop does not silently drop unsaved edits.
        await Promise.all(filesToMove.map((file) => requestEditorSaveQuiesce({ fileId: file.id })))

        try {
          const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
          await window.api.fs.rename({ oldPath: sourcePath, newPath, connectionId })

          commitFileExplorerOp({
            undo: async () => {
              await window.api.fs.rename({ oldPath: newPath, newPath: sourcePath, connectionId })
              await Promise.all([refreshDir(destDir), refreshDir(sourceDir)])
              remapOpenTabsForMovedPath(newPath, sourcePath)
            },
            redo: async () => {
              await window.api.fs.rename({ oldPath: sourcePath, newPath, connectionId })
              await Promise.all([refreshDir(sourceDir), refreshDir(destDir)])
              remapOpenTabsForMovedPath(sourcePath, newPath)
            }
          })
        } catch (err) {
          toast.error(extractIpcErrorMessage(err, `Failed to move '${fileName}'.`))
          return
        }
        await Promise.all([refreshDir(sourceDir), refreshDir(destDir)])
        remapOpenTabsForMovedPath(sourcePath, newPath)
      }
      void run()
    },
    [worktreePath, activeWorktreeId, openFiles, refreshDir]
  )

  const clearNativeDragState = useCallback(() => {
    nativeRootDragCounterRef.current = 0
    setIsNativeDragOver(false)
    setNativeDropTargetDir(null)
    // Why: for native OS file drops the preload intercepts the drop event and
    // stops propagation, so React's onDrop (which calls stopDragEdgeScroll)
    // never fires. Without this, the edge-scroll rAF loop keeps running with
    // the last recorded cursor Y, continuously overriding the user's scroll.
    stopDragEdgeScroll()
  }, [stopDragEdgeScroll])

  const rootDragHandlers = {
    onDragOver: useCallback(
      (e: React.DragEvent) => {
        const isInternal = e.dataTransfer.types.includes(ORCA_PATH_MIME)
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
      const isInternal = e.dataTransfer.types.includes(ORCA_PATH_MIME)
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
    onDragLeave: useCallback((_e: React.DragEvent) => {
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
    }, []),
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
        const sourcePath = e.dataTransfer.getData(ORCA_PATH_MIME)
        if (sourcePath && worktreePath) {
          handleMoveDrop(sourcePath, worktreePath)
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
