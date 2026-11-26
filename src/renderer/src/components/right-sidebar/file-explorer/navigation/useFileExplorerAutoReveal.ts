import { useCallback, useEffect, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { getRelativePathInsideRoot } from '@/lib/path'
import { useAppStore } from '@/store/index'
import type { PendingExplorerReveal } from '@/store/slices/editor/explorer/explorer-dir-state'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { FileExplorerRowProjection } from '../tree/file-explorer-row-projection'
import { getRevealableActiveFilePath } from './active-file-explorer-reveal'

type UseFileExplorerAutoRevealParams = {
  activeFileId: string | null
  activeWorktreeId: string | null
  worktreePath: string | null
  displayRootPath?: string | null
  pendingExplorerReveal: PendingExplorerReveal | null
  openFiles: OpenFile[]
  hasNameFilterQuery: boolean
  rowProjection: FileExplorerRowProjection
  selectedPath: string | null
  setSelectedPath: (path: string | null) => void
  cancelRevealScroll?: () => void
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
  cancelRevealScroll,
  virtualizer
}: UseFileExplorerAutoRevealParams): void {
  const revealActiveFileEnabled = useAppStore(
    (state) => state.settings?.explorerRevealActiveFile !== false
  )
  const hasObservedActiveFileRef = useRef(false)
  const prevActiveFileKeyRef = useRef<string | null>(null)
  const realTreeRevealedFileKeyRef = useRef<string | null>(null)
  const deferredByManualRevealIdRef = useRef<number | null>(null)
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
    const wasInitialized = hasObservedActiveFileRef.current
    hasObservedActiveFileRef.current = true

    if (!revealActiveFileEnabled) {
      prevActiveFileKeyRef.current = activeFileKey
      realTreeRevealedFileKeyRef.current = activeFileKey
      deferredByManualRevealIdRef.current = null
      handledSelectionRef.current = selectedPath
      return
    }

    const realTreeVisible = Boolean(worktreePath) && !hasNameFilterQuery
    const sameActiveFile = wasInitialized && activeFileKey === prevActiveFileKeyRef.current
    if (!realTreeVisible) {
      // Skip auto-reveal while hidden or filtered, remembering the active file for when the tree returns.
      if (!sameActiveFile) {
        handledSelectionRef.current = selectedPath
        prevActiveFileKeyRef.current = activeFileKey
        realTreeRevealedFileKeyRef.current = null
        deferredByManualRevealIdRef.current = null
      }
      return
    }

    if (sameActiveFile) {
      if (realTreeRevealedFileKeyRef.current === activeFileKey) {
        return
      }
    } else {
      handledSelectionRef.current = selectedPath
      prevActiveFileKeyRef.current = activeFileKey
      realTreeRevealedFileKeyRef.current = null
      deferredByManualRevealIdRef.current = null
    }

    if (!activeFileId || !activeWorktreeId || !worktreePath) {
      if (pendingExplorerReveal?.source === 'auto') {
        useAppStore.setState((state) =>
          state.pendingExplorerReveal?.source === 'auto' ? { pendingExplorerReveal: null } : state
        )
      }
      realTreeRevealedFileKeyRef.current = activeFileKey
      return
    }

    // Don't override a pending manual reveal (e.g. from Source Control or the reveal command).
    if (pendingExplorerReveal && pendingExplorerReveal.source !== 'auto') {
      if (wasInitialized && !sameActiveFile) {
        // Tab switched while a manual reveal was already pending; re-evaluate once it clears.
        deferredByManualRevealIdRef.current = pendingExplorerReveal.requestId
        return
      }
      if (deferredByManualRevealIdRef.current === pendingExplorerReveal.requestId) {
        return
      }
      // Manual reveal started after this file was already active (or before mount); let it win.
      deferredByManualRevealIdRef.current = null
      realTreeRevealedFileKeyRef.current = activeFileKey
      return
    }

    const resumedAfterManualReveal = deferredByManualRevealIdRef.current !== null
    deferredByManualRevealIdRef.current = null
    if (resumedAfterManualReveal) {
      handledSelectionRef.current = selectedPath
    }

    const activeFile = openFiles.find((file) => file.id === activeFileId)
    const filePath = getRevealableActiveFilePath(activeFile, activeWorktreeId, worktreePath)
    if (!filePath) {
      if (pendingExplorerReveal?.source === 'auto') {
        useAppStore.setState((state) =>
          state.pendingExplorerReveal?.source === 'auto' ? { pendingExplorerReveal: null } : state
        )
      }
      realTreeRevealedFileKeyRef.current = activeFileKey
      return
    }

    // Preserve a manual tree selection made while the same file stayed active.
    if (
      sameActiveFile &&
      selectedPath !== filePath &&
      selectedPath !== handledSelectionRef.current
    ) {
      realTreeRevealedFileKeyRef.current = activeFileKey
      return
    }

    const insideDisplayRoot =
      getRelativePathInsideRoot(filePath, displayRootPath ?? worktreePath) !== null
    if (insideDisplayRoot && rowProjection.hasPath(filePath)) {
      if (pendingExplorerReveal?.source === 'auto') {
        useAppStore.setState((state) =>
          state.pendingExplorerReveal?.source === 'auto' ? { pendingExplorerReveal: null } : state
        )
      }
      realTreeRevealedFileKeyRef.current = activeFileKey
      cancelRevealScroll?.()
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
      realTreeRevealedFileKeyRef.current = activeFileKey
      if (
        pendingExplorerReveal?.source === 'auto' &&
        pendingExplorerReveal.worktreeId === activeWorktreeId &&
        pendingExplorerReveal.filePath === filePath
      ) {
        return
      }
      useAppStore.setState((state) => {
        if (state.pendingExplorerReveal && state.pendingExplorerReveal.source !== 'auto') {
          return state
        }
        return {
          pendingExplorerReveal: {
            worktreeId: activeWorktreeId,
            filePath,
            requestId: Math.max(Date.now(), (state.pendingExplorerReveal?.requestId ?? 0) + 1),
            flash: false,
            source: 'auto'
          }
        }
      })
    }
  }, [
    activeFileId,
    activeWorktreeId,
    cancelRevealScroll,
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
