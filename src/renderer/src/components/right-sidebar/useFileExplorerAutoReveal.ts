import { useCallback, useEffect, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { getRelativePathInsideRoot } from '@/lib/path'
import { useAppStore } from '@/store'
import type { FileExplorerRevealOrigin } from './file-explorer-types'
import type { OpenFile } from '@/store/slices/editor'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'

type UseFileExplorerAutoRevealParams = {
  activeFileId: string | null
  activeWorktreeId: string | null
  worktreePath: string | null
  displayRootPath?: string | null
  pendingExplorerReveal: {
    worktreeId: string
    filePath: string
    requestId: number
    origin: FileExplorerRevealOrigin
  } | null
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

  useEffect(
    () => cancelScrollFrame,
    [activeWorktreeId, worktreePath, displayRootPath, cancelScrollFrame]
  )

  useEffect(() => {
    if (activeFileId === prevActiveFileIdRef.current) {
      return
    }
    prevActiveFileIdRef.current = activeFileId

    cancelScrollFrame()
    const state = useAppStore.getState()
    if (state.activeFileId !== activeFileId || state.activeWorktreeId !== activeWorktreeId) {
      return
    }
    // Manual priority is provenance, including a quiet manual request.
    if (state.pendingExplorerReveal?.origin === 'manual') {
      return
    }
    if (state.pendingExplorerReveal?.origin === 'active-file') {
      state.clearPendingExplorerReveal()
    }
    if (!activeFileId || !activeWorktreeId || !worktreePath) {
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
          const latest = useAppStore.getState()
          const current = latest.openFiles.find((file) => file.id === latest.activeFileId)
          if (
            latest.activeFileId === activeFileId &&
            latest.activeWorktreeId === activeWorktreeId &&
            !latest.pendingExplorerReveal &&
            current?.filePath === filePath &&
            current.worktreeId === activeWorktreeId &&
            (current.mode === 'edit' || current.mode === 'markdown-preview')
          ) {
            virtualizer.scrollToIndex(targetIndex, { align: 'auto' })
          }
        })
      }
    } else {
      useAppStore.setState({
        pendingExplorerReveal: {
          worktreeId: activeWorktreeId,
          filePath,
          requestId: Date.now(),
          flash: false,
          origin: 'active-file'
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
