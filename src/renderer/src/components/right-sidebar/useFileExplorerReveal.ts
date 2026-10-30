import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { getRelativePathInsideRoot } from '@/lib/path'
import { getExplorerDisplayDepth, FILE_EXPLORER_FULL_ROOT } from './file-explorer-display-root'
import { useAppStore } from '@/store'
import { getRevealAncestorDirs } from './file-explorer-paths'
import { useFileExplorerRevealRequestCurrency } from './use-file-explorer-reveal-observation'
import type { UseFileExplorerRevealParams } from './file-explorer-types'
import { fileExplorerRevealDirToReadOn } from './file-explorer-dir-pages'

/** Expands and selects reveal targets; explicit outside-scope requests restore full-root navigation. */
export function useFileExplorerReveal({
  onRevealOutsideRoot,
  activeWorktreeId,
  worktreePath,
  displayRootPath = worktreePath,
  pendingExplorerReveal,
  clearPendingExplorerReveal,
  expanded,
  dirCache,
  loadingDirPaths,
  rootCache,
  rowProjection,
  loadMoreDir,
  observeDirForReveal,
  getRevealAuthority,
  loadRevision,
  setSelectedPath,
  setFlashingPath,
  flashTimeoutRef,
  virtualizer
}: UseFileExplorerRevealParams): () => void {
  const currentRequestRef = useRef(pendingExplorerReveal)
  useLayoutEffect(() => {
    currentRequestRef.current = pendingExplorerReveal
  }, [pendingExplorerReveal])
  const revealScrollFrameRef = useRef<number | null>(null)
  const revealScrollTimeoutRef = useRef<number | null>(null)

  const cancelRevealScroll = useCallback((): void => {
    if (revealScrollFrameRef.current !== null) {
      cancelAnimationFrame(revealScrollFrameRef.current)
      revealScrollFrameRef.current = null
    }
    if (revealScrollTimeoutRef.current !== null) {
      window.clearTimeout(revealScrollTimeoutRef.current)
      revealScrollTimeoutRef.current = null
    }
  }, [])

  const cancelRevealTimers = useCallback((): void => {
    cancelRevealScroll()
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current)
      flashTimeoutRef.current = null
    }
  }, [cancelRevealScroll, flashTimeoutRef])

  useEffect(
    () => cancelRevealScroll,
    [activeWorktreeId, worktreePath, displayRootPath, cancelRevealScroll]
  )

  const isCurrentRequest = useFileExplorerRevealRequestCurrency(activeWorktreeId, displayRootPath)

  const pendingRevealAncestorDirs = useMemo(() => {
    if (
      !pendingExplorerReveal ||
      !activeWorktreeId ||
      pendingExplorerReveal.worktreeId !== activeWorktreeId ||
      !worktreePath
    ) {
      return null
    }

    if (getRelativePathInsideRoot(pendingExplorerReveal.filePath, worktreePath) === null) {
      return null
    }
    return getRevealAncestorDirs(displayRootPath ?? worktreePath, pendingExplorerReveal.filePath)
  }, [activeWorktreeId, pendingExplorerReveal, worktreePath, displayRootPath])

  useEffect(() => {
    if (!pendingExplorerReveal || !activeWorktreeId || !worktreePath) {
      return
    }

    if (
      pendingExplorerReveal.worktreeId !== activeWorktreeId ||
      !isCurrentRequest(pendingExplorerReveal)
    ) {
      return
    }
    if (
      getRelativePathInsideRoot(pendingExplorerReveal.filePath, worktreePath) !== null &&
      getRelativePathInsideRoot(pendingExplorerReveal.filePath, displayRootPath) === null
    ) {
      if (onRevealOutsideRoot) {
        onRevealOutsideRoot()
      } else {
        useAppStore
          .getState()
          .setExplorerDisplayRootForWorktree(activeWorktreeId, FILE_EXPLORER_FULL_ROOT)
      }
      return
    }
    if (!pendingRevealAncestorDirs) {
      clearPendingExplorerReveal()
      return
    }

    useAppStore.setState((state) => {
      const currentExpanded = state.expandedDirs[activeWorktreeId] ?? new Set<string>()
      const nextExpanded = new Set(currentExpanded)
      let changed = false

      for (const dirPath of pendingRevealAncestorDirs) {
        if (!nextExpanded.has(dirPath)) {
          nextExpanded.add(dirPath)
          changed = true
        }
      }

      if (!changed) {
        return state
      }

      return {
        expandedDirs: {
          ...state.expandedDirs,
          [activeWorktreeId]: nextExpanded
        }
      }
    })

    let alive = true
    const request = pendingExplorerReveal
    const isCurrent = () =>
      alive && currentRequestRef.current === request && isCurrentRequest(request)
    void (async () => {
      const paths = [displayRootPath ?? worktreePath, ...pendingRevealAncestorDirs]
      for (const path of paths) {
        if (!isCurrent()) {
          return
        }
        const outcome = await observeDirForReveal(
          path,
          getExplorerDisplayDepth(worktreePath, path) - 1,
          request.origin,
          isCurrent
        )
        if (!isCurrent() || outcome !== 'refreshed') {
          return
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [
    activeWorktreeId,
    clearPendingExplorerReveal,
    observeDirForReveal,
    isCurrentRequest,
    pendingExplorerReveal,
    pendingRevealAncestorDirs,
    onRevealOutsideRoot,
    worktreePath,
    displayRootPath
  ])

  useEffect(() => {
    if (
      !pendingExplorerReveal ||
      !activeWorktreeId ||
      pendingExplorerReveal.worktreeId !== activeWorktreeId ||
      !worktreePath ||
      !pendingRevealAncestorDirs ||
      !isCurrentRequest(pendingExplorerReveal)
    ) {
      return
    }

    const targetPath = pendingExplorerReveal.filePath
    const parentDirPath =
      pendingRevealAncestorDirs.length > 0
        ? pendingRevealAncestorDirs.at(-1)!
        : (displayRootPath ?? worktreePath)
    const parentDirCache = dirCache[parentDirPath]
    const missingExpandedAncestor = pendingRevealAncestorDirs.find(
      (dirPath) => !expanded.has(dirPath)
    )
    const missingAncestor = pendingRevealAncestorDirs.find(
      (dirPath) => !rowProjection.hasPath(dirPath)
    )
    const prerequisites = [
      ...new Set([
        worktreePath,
        displayRootPath ?? worktreePath,
        ...pendingRevealAncestorDirs,
        parentDirPath
      ])
    ]
    const authority = getRevealAuthority(prerequisites, dirCache)
    if (authority === 'pending') {
      return
    }
    if (prerequisites.some((path) => dirCache[path]?.error)) {
      if (isCurrentRequest(pendingExplorerReveal)) {
        clearPendingExplorerReveal()
      }
      return
    }
    const readOn = loadMoreDir
      ? fileExplorerRevealDirToReadOn(dirCache, rowProjection, [
          ...pendingRevealAncestorDirs,
          targetPath
        ])
      : null
    if (readOn !== null) {
      if (!loadingDirPaths.has(readOn)) {
        void loadMoreDir?.(readOn)
      }
      return
    }
    if (missingExpandedAncestor || missingAncestor || !parentDirCache) {
      return
    }

    const fallbackPath = rowProjection.hasPath(parentDirPath) ? parentDirPath : null
    const revealPath = rowProjection.hasPath(targetPath) ? targetPath : fallbackPath
    if (!revealPath) {
      clearPendingExplorerReveal()
      return
    }

    if (!isCurrentRequest(pendingExplorerReveal)) {
      return
    }
    const selectedActiveFileId = useAppStore.getState().activeFileId
    const canDeliver = () => {
      const state = useAppStore.getState()
      return (
        isCurrentRequest(pendingExplorerReveal, true) && state.activeFileId === selectedActiveFileId
      )
    }
    clearPendingExplorerReveal()
    setSelectedPath(revealPath)

    // Manual reveals flash; automatic tab-switch reveals stay quiet.
    if (pendingExplorerReveal.flash !== false) {
      setFlashingPath(revealPath)
      if (flashTimeoutRef.current !== null) {
        window.clearTimeout(flashTimeoutRef.current)
      }
      flashTimeoutRef.current = window.setTimeout(() => {
        setFlashingPath((current) => (current === revealPath ? null : current))
        flashTimeoutRef.current = null
      }, 2000)
    }

    cancelRevealScroll()
    revealScrollFrameRef.current = requestAnimationFrame(() => {
      revealScrollFrameRef.current = null
      if (!canDeliver()) {
        return
      }
      revealScrollTimeoutRef.current = window.setTimeout(() => {
        revealScrollTimeoutRef.current = null
        if (!canDeliver()) {
          return
        }
        const targetIndex = rowProjection.getIndexByPath(revealPath)
        if (targetIndex !== null) {
          virtualizer.scrollToIndex(targetIndex, { align: 'center' })
        }
      }, 0)
    })
  }, [
    activeWorktreeId,
    cancelRevealScroll,
    clearPendingExplorerReveal,
    dirCache,
    expanded,
    loadMoreDir,
    loadingDirPaths,
    getRevealAuthority,
    loadRevision,
    isCurrentRequest,
    pendingExplorerReveal,
    pendingRevealAncestorDirs,
    rowProjection,
    rootCache,
    setFlashingPath,
    setSelectedPath,
    flashTimeoutRef,
    virtualizer,
    worktreePath,
    displayRootPath
  ])

  return cancelRevealTimers
}
