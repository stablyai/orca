import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { getRelativePathInsideRoot } from '@/lib/path'
import { getExplorerDisplayDepth, FILE_EXPLORER_FULL_ROOT } from './file-explorer-display-root'
import { useAppStore } from '@/store'
import { getRevealAncestorDirs } from './file-explorer-paths'
import type { DirCache } from './file-explorer-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'

type UseFileExplorerRevealParams = {
  activeWorktreeId: string | null
  worktreePath: string | null
  displayRootPath?: string | null
  pendingExplorerReveal: {
    worktreeId: string
    filePath: string
    requestId: number
    flash?: boolean
  } | null
  clearPendingExplorerReveal: () => void
  expanded: Set<string>
  dirCache: Record<string, DirCache>
  loadingDirPaths: ReadonlySet<string>
  rootCache: DirCache | undefined
  rowProjection: FileExplorerRowProjection
  loadDir: (dirPath: string, depth: number, options?: { force?: boolean }) => Promise<boolean>
  setSelectedPath: (path: string | null) => void
  setFlashingPath: Dispatch<SetStateAction<string | null>>
  flashTimeoutRef: RefObject<number | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
}

/** Expands and selects reveal targets; explicit outside-scope requests restore full-root navigation. */
export function useFileExplorerReveal({
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
  loadDir,
  setSelectedPath,
  setFlashingPath,
  flashTimeoutRef,
  virtualizer
}: UseFileExplorerRevealParams): () => void {
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

    if (pendingExplorerReveal.worktreeId !== activeWorktreeId) {
      return
    }
    if (
      getRelativePathInsideRoot(pendingExplorerReveal.filePath, worktreePath) !== null &&
      getRelativePathInsideRoot(pendingExplorerReveal.filePath, displayRootPath) === null
    ) {
      useAppStore
        .getState()
        .setExplorerDisplayRootForWorktree(activeWorktreeId, FILE_EXPLORER_FULL_ROOT)
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

    void (async () => {
      const rootLoaded = await loadDir(
        displayRootPath ?? worktreePath,
        getExplorerDisplayDepth(worktreePath, displayRootPath) - 1
      )
      if (!rootLoaded) {
        return
      }

      for (let depth = 0; depth < pendingRevealAncestorDirs.length; depth += 1) {
        const ancestorLoaded = await loadDir(
          pendingRevealAncestorDirs[depth],
          getExplorerDisplayDepth(worktreePath, pendingRevealAncestorDirs[depth]) - 1
        )
        if (!ancestorLoaded) {
          return
        }
      }
    })()
  }, [
    activeWorktreeId,
    clearPendingExplorerReveal,
    loadDir,
    pendingExplorerReveal,
    pendingRevealAncestorDirs,
    worktreePath,
    displayRootPath
  ])

  useEffect(() => {
    if (
      !pendingExplorerReveal ||
      !activeWorktreeId ||
      pendingExplorerReveal.worktreeId !== activeWorktreeId ||
      !worktreePath ||
      !pendingRevealAncestorDirs
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
    const rootStillLoading = !rootCache || loadingDirPaths.has(displayRootPath ?? worktreePath)
    const parentDirStillLoading =
      parentDirPath === (displayRootPath ?? worktreePath)
        ? rootStillLoading
        : !parentDirCache || loadingDirPaths.has(parentDirPath)
    const parentDirKnown =
      parentDirPath === (displayRootPath ?? worktreePath) ? !!rootCache : !!parentDirCache

    if (
      !rootStillLoading &&
      (rootCache?.error ||
        parentDirCache?.error ||
        pendingRevealAncestorDirs.some((path) => dirCache[path]?.error))
    ) {
      clearPendingExplorerReveal()
      return
    }
    if (
      rootStillLoading ||
      missingExpandedAncestor ||
      missingAncestor ||
      parentDirStillLoading ||
      !parentDirKnown
    ) {
      return
    }

    const fallbackPath = rowProjection.hasPath(parentDirPath) ? parentDirPath : null
    const revealPath = rowProjection.hasPath(targetPath) ? targetPath : fallbackPath
    if (!revealPath) {
      clearPendingExplorerReveal()
      return
    }

    clearPendingExplorerReveal()
    setSelectedPath(revealPath)

    // Only flash when explicitly requested (e.g. "Reveal in Explorer" from Source Control).
    // Auto-reveals on tab switch skip the flash to avoid visual noise.
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
      revealScrollTimeoutRef.current = window.setTimeout(() => {
        revealScrollTimeoutRef.current = null
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
    loadingDirPaths,
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
