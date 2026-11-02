import { useCallback, useEffect, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { getRelativePathInsideRoot } from '@/lib/path'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { isExplorerRootOutsideWorkspace } from './file-explorer-display-root'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'

type UseFileExplorerAutoRevealParams = {
  activeFileId: string | null
  activeWorktreeId: string | null
  worktreePath: string | null
  displayRootPath?: string | null
  pendingExplorerReveal: { worktreeId: string; filePath: string; requestId: number } | null
  openFiles: OpenFile[]
  rowProjection: FileExplorerRowProjection
  setSelectedPath: (path: string | null) => void
  virtualizer: Virtualizer<HTMLDivElement, Element>
}

/** Follow active editor files without flashing; expand collapsed ancestors through the reveal machinery. */
export function useFileExplorerAutoReveal({
  activeFileId,
  activeWorktreeId,
  worktreePath,
  displayRootPath = worktreePath,
  pendingExplorerReveal,
  openFiles,
  rowProjection,
  setSelectedPath,
  virtualizer
}: UseFileExplorerAutoRevealParams): void {
  const prevActiveFileIdRef = useRef<string | null>(null)
  const scrollFrameRef = useRef<number | null>(null)

  const cancelScrollFrame = useCallback((): void => {
    if (scrollFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = null
  }, [])

  useEffect(() => cancelScrollFrame, [cancelScrollFrame])

  useEffect(() => {
    if (activeFileId === prevActiveFileIdRef.current) {
      return
    }
    prevActiveFileIdRef.current = activeFileId

    if (!activeFileId || !activeWorktreeId || !worktreePath) {
      return
    }

    // Don't override a pending manual reveal (e.g. from Source Control "Reveal in Explorer")
    if (pendingExplorerReveal) {
      return
    }
    if (isExplorerRootOutsideWorkspace(worktreePath, displayRootPath)) {
      return
    }

    // Markdown previews own concrete files and sync selection; diff/conflict surfaces do not.
    const activeFile = openFiles.find((f) => f.id === activeFileId)
    if (
      !activeFile ||
      activeFile.worktreeId !== activeWorktreeId ||
      (activeFile.mode !== 'edit' && activeFile.mode !== 'markdown-preview')
    ) {
      return
    }

    const filePath = activeFile.filePath
    if (getRelativePathInsideRoot(filePath, displayRootPath) === null) {
      return
    }

    if (rowProjection.hasPath(filePath)) {
      setSelectedPath(filePath)
      const targetIndex = rowProjection.getIndexByPath(filePath)
      if (targetIndex !== null) {
        cancelScrollFrame()
        scrollFrameRef.current = requestAnimationFrame(() => {
          scrollFrameRef.current = null
          virtualizer.scrollToIndex(targetIndex, { align: 'auto' })
        })
      }
    } else {
      useAppStore.setState({
        pendingExplorerReveal: {
          worktreeId: activeWorktreeId,
          filePath,
          requestId: Date.now(),
          flash: false
        }
      })
    }
  }, [
    activeFileId,
    activeWorktreeId,
    cancelScrollFrame,
    worktreePath,
    displayRootPath,
    pendingExplorerReveal,
    openFiles,
    rowProjection,
    setSelectedPath,
    virtualizer
  ])
}
