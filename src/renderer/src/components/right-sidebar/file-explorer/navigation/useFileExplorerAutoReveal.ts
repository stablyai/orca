import { useCallback, useEffect, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { getRelativePathInsideRoot } from '@/lib/path'
import { useAppStore } from '@/store/index'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { FileExplorerRowProjection } from '../tree/file-explorer-row-projection'

type UseFileExplorerAutoRevealParams = {
  activeFileId: string | null
  activeWorktreeId: string | null
  worktreePath: string | null
  displayRootPath?: string | null
  pendingExplorerReveal: { worktreeId: string; filePath: string; requestId: number } | null
  openFiles: OpenFile[]
  hasNameFilterQuery: boolean
  rowProjection: FileExplorerRowProjection
  selectedPath: string | null
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
  hasNameFilterQuery,
  rowProjection,
  selectedPath,
  setSelectedPath,
  virtualizer
}: UseFileExplorerAutoRevealParams): void {
  const prevActiveFileIdRef = useRef<string | null>(null)
  const realTreeRevealedFileIdRef = useRef<string | null>(null)
  const handledSelectionRef = useRef<string | null>(null)
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
    const realTreeVisible = Boolean(worktreePath) && !hasNameFilterQuery
    // Why: a file handled among name-filter rows is revealed in the real tree once the filter clears.
    // A hidden tree leaves it unhandled, unless a kept name filter would be cleared by that reveal.
    const sameActiveFile = activeFileId === prevActiveFileIdRef.current
    if (sameActiveFile) {
      if (!realTreeVisible || realTreeRevealedFileIdRef.current === activeFileId) {
        return
      }
    } else if (!worktreePath && !hasNameFilterQuery) {
      prevActiveFileIdRef.current = null
      return
    } else {
      handledSelectionRef.current = selectedPath
    }
    prevActiveFileIdRef.current = activeFileId
    realTreeRevealedFileIdRef.current = realTreeVisible ? activeFileId : null

    if (!activeFileId || !activeWorktreeId || !worktreePath) {
      return
    }

    // Don't override a pending manual reveal (e.g. from Source Control "Reveal in Explorer")
    if (pendingExplorerReveal) {
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
    // Why: after the name filter clears, keep a row the user selected since the file was handled.
    if (
      sameActiveFile &&
      selectedPath !== filePath &&
      selectedPath !== handledSelectionRef.current
    ) {
      return
    }

    if (rowProjection.hasPath(filePath)) {
      setSelectedPath(filePath)
      handledSelectionRef.current = filePath
      const targetIndex = rowProjection.getIndexByPath(filePath)
      if (targetIndex !== null) {
        cancelScrollFrame()
        scrollFrameRef.current = requestAnimationFrame(() => {
          scrollFrameRef.current = null
          virtualizer.scrollToIndex(targetIndex, { align: 'auto' })
        })
      }
    } else {
      // Queuing the reveal expands the real tree and clears a name filter, so it is handled.
      realTreeRevealedFileIdRef.current = activeFileId
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
    hasNameFilterQuery,
    rowProjection,
    selectedPath,
    setSelectedPath,
    virtualizer
  ])
}
