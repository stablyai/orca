import { useCallback, useEffect, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { getRelativePathInsideRoot } from '@/lib/path'
import { useAppStore } from '@/store/index'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { FileExplorerRowProjection } from '../tree/file-explorer-row-projection'
import { getRevealableActiveFilePath } from './active-file-explorer-reveal'

type UseFileExplorerAutoRevealParams = {
  activeFileId: string | null
  activeWorktreeId: string | null
  worktreePath: string | null
  displayRootPath?: string | null
  pendingExplorerReveal: {
    worktreeId: string
    filePath: string
    requestId: number
    flash?: boolean
  } | null
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
  const revealActiveFileEnabled = useAppStore(
    (state) => state.settings?.explorerRevealActiveFile !== false
  )
  const prevActiveFileKeyRef = useRef<string | null>(null)
  const realTreeRevealedFileKeyRef = useRef<string | null>(null)
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
    const activeFileKey =
      activeWorktreeId && activeFileId ? `${activeWorktreeId}\0${activeFileId}` : null
    if (!revealActiveFileEnabled) {
      prevActiveFileKeyRef.current = activeFileKey
      realTreeRevealedFileKeyRef.current = activeFileKey
      handledSelectionRef.current = selectedPath
      return
    }

    const realTreeVisible = Boolean(worktreePath) && !hasNameFilterQuery
    const sameActiveFile = activeFileKey === prevActiveFileKeyRef.current
    if (!realTreeVisible) {
      // Skip auto-reveal while hidden or filtered, remembering the active file for when the tree returns.
      if (!sameActiveFile) {
        handledSelectionRef.current = selectedPath
        prevActiveFileKeyRef.current = activeFileKey
        realTreeRevealedFileKeyRef.current = null
      }
      return
    }

    if (sameActiveFile) {
      if (realTreeRevealedFileKeyRef.current === activeFileKey) {
        return
      }
    } else {
      handledSelectionRef.current = selectedPath
    }
    prevActiveFileKeyRef.current = activeFileKey
    realTreeRevealedFileKeyRef.current = activeFileKey

    if (!activeFileId || !activeWorktreeId || !worktreePath) {
      return
    }

    // Don't override a pending manual reveal (e.g. from Source Control or the reveal command).
    if (pendingExplorerReveal) {
      return
    }

    const activeFile = openFiles.find((file) => file.id === activeFileId)
    const filePath = getRevealableActiveFilePath(activeFile, activeWorktreeId, worktreePath)
    if (!filePath) {
      return
    }

    // Preserve a manual tree selection made while the same file stayed active.
    if (
      sameActiveFile &&
      selectedPath !== filePath &&
      selectedPath !== handledSelectionRef.current
    ) {
      return
    }

    const insideDisplayRoot =
      getRelativePathInsideRoot(filePath, displayRootPath ?? worktreePath) !== null
    if (insideDisplayRoot && rowProjection.hasPath(filePath)) {
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
      useAppStore.setState((state) => ({
        pendingExplorerReveal: {
          worktreeId: activeWorktreeId,
          filePath,
          requestId: Math.max(Date.now(), (state.pendingExplorerReveal?.requestId ?? 0) + 1),
          flash: false
        }
      }))
    }
  }, [
    activeFileId,
    activeWorktreeId,
    cancelScrollFrame,
    displayRootPath,
    hasNameFilterQuery,
    openFiles,
    pendingExplorerReveal,
    revealActiveFileEnabled,
    rowProjection,
    selectedPath,
    setSelectedPath,
    virtualizer,
    worktreePath
  ])
}
