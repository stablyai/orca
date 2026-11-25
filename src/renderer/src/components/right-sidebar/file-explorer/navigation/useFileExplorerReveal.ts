import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { getRelativePathInsideRoot } from '@/lib/path'
import { getExplorerDisplayDepth } from './file-explorer-display-root'
import { FILE_EXPLORER_FULL_ROOT } from '../../../../../../shared/file-listing/file-explorer-display-root'
import { useAppStore } from '@/store/index'
import { getRevealTarget } from './file-explorer-paths'
import type { DirCache } from '../tree/file-explorer-types'
import type { FileExplorerRowProjection } from '../tree/file-explorer-row-projection'
import { fileExplorerRevealDirToReadOn } from '../tree/file-explorer-dir-pages'

type UseFileExplorerRevealParams = {
  onRevealOutsideRoot?: () => void
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
  loadMoreDir?: (dirPath: string) => Promise<void>
  setSelectedPath: (path: string | null) => void
  setFlashingPath: Dispatch<SetStateAction<string | null>>
  flashTimeoutRef: RefObject<number | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
}

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
  loadDir,
  loadMoreDir,
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

  const pendingRevealTarget = useMemo(() => {
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
    return getRevealTarget(displayRootPath ?? worktreePath, pendingExplorerReveal.filePath)
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
      if (onRevealOutsideRoot) {
        onRevealOutsideRoot()
      } else {
        useAppStore
          .getState()
          .setExplorerDisplayRootForWorktree(activeWorktreeId, FILE_EXPLORER_FULL_ROOT)
      }
      return
    }
    if (!pendingRevealTarget) {
      clearPendingExplorerReveal()
      return
    }
    const { ancestorDirs } = pendingRevealTarget

    useAppStore.setState((state) => {
      const currentExpanded = state.expandedDirs[activeWorktreeId] ?? new Set<string>()
      const nextExpanded = new Set(currentExpanded)
      let changed = false

      for (const dirPath of ancestorDirs) {
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

      for (const dirPath of ancestorDirs) {
        const ancestorLoaded = await loadDir(
          dirPath,
          getExplorerDisplayDepth(worktreePath, dirPath) - 1
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
    pendingRevealTarget,
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
      !pendingRevealTarget
    ) {
      return
    }

    const { targetPath, ancestorDirs } = pendingRevealTarget
    const parentDirPath = ancestorDirs.at(-1) ?? displayRootPath ?? worktreePath
    const parentDirCache = dirCache[parentDirPath]
    const missingExpandedAncestor = ancestorDirs.find((dirPath) => !expanded.has(dirPath))
    const missingAncestor = ancestorDirs.find((dirPath) => !rowProjection.hasPath(dirPath))
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
        ancestorDirs.some((path) => dirCache[path]?.error))
    ) {
      clearPendingExplorerReveal()
      return
    }
    const readOn = loadMoreDir
      ? fileExplorerRevealDirToReadOn(dirCache, rowProjection, [...ancestorDirs, targetPath])
      : null
    if (readOn !== null) {
      if (!loadingDirPaths.has(readOn)) {
        void loadMoreDir?.(readOn)
      }
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
    loadMoreDir,
    loadingDirPaths,
    pendingExplorerReveal,
    pendingRevealTarget,
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
