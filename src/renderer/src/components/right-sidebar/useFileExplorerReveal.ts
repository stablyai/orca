import { useEffect, useMemo } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { getRevealAncestorDirs } from './file-explorer-paths'
import type { DirCache, TreeNode } from './file-explorer-types'

type UseFileExplorerRevealParams = {
  activeWorktreeId: string | null
  worktreePath: string | null
  pendingExplorerReveal: {
    worktreeId: string
    filePath: string
    requestId: number
    flash?: boolean
  } | null
  clearPendingExplorerReveal: () => void
  expanded: Set<string>
  dirCache: Record<string, DirCache>
  rootCache: DirCache | undefined
  rowsByPath: Map<string, TreeNode>
  flatRows: TreeNode[]
  loadDir: (dirPath: string, depth: number, options?: { force?: boolean }) => Promise<void>
  setSelectedPath: Dispatch<SetStateAction<string | null>>
  setFlashingPath: Dispatch<SetStateAction<string | null>>
  flashTimeoutRef: RefObject<number | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
}

export function useFileExplorerReveal({
  activeWorktreeId,
  worktreePath,
  pendingExplorerReveal,
  clearPendingExplorerReveal,
  expanded,
  dirCache,
  rootCache,
  rowsByPath,
  flatRows,
  loadDir,
  setSelectedPath,
  setFlashingPath,
  flashTimeoutRef,
  virtualizer
}: UseFileExplorerRevealParams): void {
  const pendingRevealAncestorDirs = useMemo(() => {
    if (
      !pendingExplorerReveal ||
      !activeWorktreeId ||
      pendingExplorerReveal.worktreeId !== activeWorktreeId ||
      !worktreePath
    ) {
      return null
    }

    return getRevealAncestorDirs(worktreePath, pendingExplorerReveal.filePath)
  }, [activeWorktreeId, pendingExplorerReveal, worktreePath])

  useEffect(() => {
    if (!pendingExplorerReveal || !activeWorktreeId || !worktreePath) {
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
      await loadDir(worktreePath, -1)

      for (let depth = 0; depth < pendingRevealAncestorDirs.length; depth += 1) {
        await loadDir(pendingRevealAncestorDirs[depth], depth)
      }
    })()
  }, [
    activeWorktreeId,
    clearPendingExplorerReveal,
    loadDir,
    pendingExplorerReveal,
    pendingRevealAncestorDirs,
    worktreePath
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
      pendingRevealAncestorDirs.length > 0 ? pendingRevealAncestorDirs.at(-1)! : worktreePath
    const parentDirCache = dirCache[parentDirPath]
    const missingExpandedAncestor = pendingRevealAncestorDirs.find(
      (dirPath) => !expanded.has(dirPath)
    )
    const missingAncestor = pendingRevealAncestorDirs.find((dirPath) => !rowsByPath.has(dirPath))
    const parentDirStillLoading =
      parentDirPath === worktreePath
        ? (rootCache?.loading ?? true)
        : (parentDirCache?.loading ?? true)
    const parentDirKnown = parentDirPath === worktreePath ? !!rootCache : !!parentDirCache

    if (
      (rootCache?.loading ?? true) ||
      missingExpandedAncestor ||
      missingAncestor ||
      parentDirStillLoading ||
      !parentDirKnown
    ) {
      return
    }

    const fallbackPath = rowsByPath.has(parentDirPath) ? parentDirPath : null
    const revealPath = rowsByPath.has(targetPath) ? targetPath : fallbackPath
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

    requestAnimationFrame(() => {
      window.setTimeout(() => {
        const targetIndex = flatRows.findIndex((row) => row.path === revealPath)
        if (targetIndex !== -1) {
          virtualizer.scrollToIndex(targetIndex, { align: 'center' })
        }
      }, 0)
    })
  }, [
    activeWorktreeId,
    clearPendingExplorerReveal,
    dirCache,
    expanded,
    flatRows,
    pendingExplorerReveal,
    pendingRevealAncestorDirs,
    rootCache,
    rowsByPath,
    setFlashingPath,
    setSelectedPath,
    flashTimeoutRef,
    virtualizer,
    worktreePath
  ])
}
