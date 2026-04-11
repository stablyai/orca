import type { Dispatch, SetStateAction } from 'react'
import type { DirCache } from './file-explorer-types'
import { normalizeAbsolutePath, isPathEqualOrDescendant } from './file-explorer-paths'
import { useAppStore } from '@/store'

// ── dirCache subtree purge ───────────────────────────────────────────
// Why: dirCache is component-local useState in useFileExplorerTree, not
// Zustand. This helper accepts the setter so it can be called from the
// watch effect without Zustand coupling. See design §5.2.

export function purgeDirCacheSubtree(
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>,
  deletedPath: string
): void {
  const normalized = normalizeAbsolutePath(deletedPath)
  setDirCache((prev) => {
    let changed = false
    const next: Record<string, DirCache> = {}
    for (const key of Object.keys(prev)) {
      if (isPathEqualOrDescendant(key, normalized)) {
        changed = true
      } else {
        next[key] = prev[key]
      }
    }
    return changed ? next : prev
  })
}

// ── expandedDirs subtree purge ───────────────────────────────────────
// Why: expandedDirs lives in Zustand keyed by worktreeId. After an
// external directory delete, all expanded descendants of the deleted
// path must be removed so the tree doesn't show phantom folders.

export function purgeExpandedDirsSubtree(worktreeId: string, deletedPath: string): void {
  const normalized = normalizeAbsolutePath(deletedPath)
  useAppStore.setState((state) => {
    const current = state.expandedDirs[worktreeId]
    if (!current) {
      return state
    }

    const next = new Set<string>()
    let changed = false
    for (const dirPath of current) {
      if (isPathEqualOrDescendant(dirPath, normalized)) {
        changed = true
      } else {
        next.add(dirPath)
      }
    }

    if (!changed) {
      return state
    }

    return { expandedDirs: { ...state.expandedDirs, [worktreeId]: next } }
  })
}

// ── pendingExplorerReveal cleanup ────────────────────────────────────
// Why: if the reveal target was inside a deleted subtree, keeping it
// would cause the reveal logic to expand stale ancestor directories.

export function clearStalePendingReveal(deletedPath: string): void {
  const normalized = normalizeAbsolutePath(deletedPath)
  useAppStore.setState((state) => {
    if (
      state.pendingExplorerReveal &&
      isPathEqualOrDescendant(
        normalizeAbsolutePath(state.pendingExplorerReveal.filePath),
        normalized
      )
    ) {
      return { pendingExplorerReveal: null }
    }
    return state
  })
}
