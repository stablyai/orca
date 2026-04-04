import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { basename, dirname, joinPath } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'

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
  // Stops the drag edge auto-scroll loop (call on drag end / unmount)
  stopDragEdgeScroll: () => void
  rootDragHandlers: {
    onDragOver: (e: React.DragEvent) => void
    onDragEnter: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
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
  const closeFile = useAppStore((s) => s.closeFile)
  const openFile = useAppStore((s) => s.openFile)

  const [isRootDragOver, setIsRootDragOver] = useState(false)
  const rootDragCounterRef = useRef(0)
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null)
  const [dragSourcePath, setDragSourcePath] = useState<string | null>(null)

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
      const fileName = basename(sourcePath)
      const sourceDir = dirname(sourcePath)

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
        try {
          await window.api.fs.rename({ oldPath: sourcePath, newPath })
        } catch (err) {
          toast.error(extractIpcErrorMessage(err, `Failed to move '${fileName}'.`))
          return
        }

        await Promise.all([refreshDir(sourceDir), refreshDir(destDir)])

        // Update any open editor tabs whose paths were under the moved item.
        // Since OpenFile.id === filePath, we close the old tab and reopen at
        // the new path so all derived state (relativePath, language) stays correct.
        for (const file of openFiles) {
          let oldFilePath: string | null = null
          if (file.filePath === sourcePath) {
            oldFilePath = sourcePath
          } else if (
            file.filePath.startsWith(`${sourcePath}/`) ||
            file.filePath.startsWith(`${sourcePath}\\`)
          ) {
            oldFilePath = file.filePath
          }
          if (!oldFilePath) {
            continue
          }

          const suffix = oldFilePath.slice(sourcePath.length)
          const updatedPath = newPath + suffix
          const updatedRelative = updatedPath.slice(worktreePath.length + 1)

          closeFile(oldFilePath)
          openFile({
            filePath: updatedPath,
            relativePath: updatedRelative,
            worktreeId: file.worktreeId,
            language: detectLanguage(basename(updatedPath)),
            mode: 'edit'
          })
        }
      }
      void run()
    },
    [worktreePath, activeWorktreeId, openFiles, closeFile, openFile, refreshDir]
  )

  const rootDragHandlers = {
    onDragOver: useCallback(
      (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(ORCA_PATH_MIME)) {
          return
        }
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        lastDragClientYRef.current = e.clientY
        if (edgeScrollRafRef.current === null) {
          edgeScrollRafRef.current = requestAnimationFrame(tickDragEdgeScroll)
        }
      },
      [tickDragEdgeScroll]
    ),
    onDragEnter: useCallback((e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(ORCA_PATH_MIME)) {
        return
      }
      e.preventDefault()
      rootDragCounterRef.current += 1
      setIsRootDragOver(true)
    }, []),
    onDragLeave: useCallback((_e: React.DragEvent) => {
      rootDragCounterRef.current -= 1
      if (rootDragCounterRef.current <= 0) {
        rootDragCounterRef.current = 0
        setIsRootDragOver(false)
      }
    }, []),
    onDrop: useCallback(
      (e: React.DragEvent) => {
        e.preventDefault()
        stopDragEdgeScroll()
        rootDragCounterRef.current = 0
        setIsRootDragOver(false)
        setDropTargetDir(null)
        const sourcePath = e.dataTransfer.getData(ORCA_PATH_MIME)
        if (sourcePath && worktreePath) {
          handleMoveDrop(sourcePath, worktreePath)
        }
      },
      [worktreePath, handleMoveDrop, stopDragEdgeScroll]
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

  return {
    handleMoveDrop,
    handleDragExpandDir,
    dropTargetDir,
    setDropTargetDir,
    dragSourcePath,
    setDragSourcePath,
    isRootDragOver,
    stopDragEdgeScroll,
    rootDragHandlers
  }
}
