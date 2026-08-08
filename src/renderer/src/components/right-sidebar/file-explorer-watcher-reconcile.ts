import type { Dispatch, SetStateAction } from 'react'
import type { DirCache } from './file-explorer-types'
import { normalizeAbsolutePath, isPathEqualOrDescendant } from './file-explorer-paths'
import { useAppStore } from '@/store'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'

// ── dirCache subtree purge ───────────────────────────────────────────
// Why: dirCache is component-local useState in useFileExplorerTree, not
// Zustand. This helper accepts the setter so it can be called from the
// watch effect without Zustand coupling. See design §5.2.

function createSubtreeMatcher(paths: ReadonlySet<string>): (candidatePath: string) => boolean {
  const normalizedRoots = new Set([...paths].map(normalizeRuntimePathForComparison))
  return (candidatePath) => {
    const candidate = normalizeRuntimePathForComparison(candidatePath)
    if (normalizedRoots.has(candidate)) {
      return true
    }
    if (candidate.startsWith('/') && normalizedRoots.has('/')) {
      return true
    }
    for (
      let index = candidate.indexOf('/');
      index >= 0;
      index = candidate.indexOf('/', index + 1)
    ) {
      if (
        index === 2 &&
        /^[a-z]:\//.test(candidate) &&
        normalizedRoots.has(candidate.slice(0, 3))
      ) {
        return true
      }
      if (index > 0 && normalizedRoots.has(candidate.slice(0, index))) {
        return true
      }
    }
    return false
  }
}

export function purgeDirCacheSubtrees(
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>,
  deletedPaths: ReadonlySet<string>
): void {
  if (deletedPaths.size === 0) {
    return
  }
  const shouldPurge = createSubtreeMatcher(deletedPaths)
  setDirCache((prev) => {
    let changed = false
    const next: Record<string, DirCache> = {}
    for (const key of Object.keys(prev)) {
      if (shouldPurge(key)) {
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

export function purgeExpandedDirsSubtrees(
  worktreeId: string,
  deletedPaths: ReadonlySet<string>
): void {
  if (deletedPaths.size === 0) {
    return
  }
  const shouldPurge = createSubtreeMatcher(deletedPaths)
  useAppStore.setState((state) => {
    const current = state.expandedDirs[worktreeId]
    if (!current) {
      return state
    }

    const next = new Set<string>()
    let changed = false
    for (const dirPath of current) {
      if (shouldPurge(dirPath)) {
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
