import type { Dispatch, SetStateAction } from 'react'
import type { DirCache } from './file-explorer-types'
import { isPathEqualOrDescendant } from './file-explorer-paths'
import { useAppStore } from '@/store'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'

// dirCache is component-local; accept its setter without coupling the watch effect to Zustand (design §5.2).

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
  deletedPaths: ReadonlySet<string>,
  snapshot?: { cache: Record<string, DirCache>; keys: readonly string[] }
): void {
  if (deletedPaths.size === 0) {
    return
  }
  const shouldPurge = createSubtreeMatcher(deletedPaths)
  setDirCache((prev) => {
    let changed = false
    const next: Record<string, DirCache> = {}
    const keys = prev === snapshot?.cache ? snapshot.keys : Object.keys(prev)
    for (const key of keys) {
      if (shouldPurge(key)) {
        changed = true
      } else {
        next[key] = prev[key]
      }
    }
    return changed ? next : prev
  })
}

// Purge expanded descendants from Zustand after external deletion to prevent phantom folders.

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

// Drop deleted reveal targets so reveal cannot expand stale ancestors.

export function clearStalePendingReveal(deletedPath: string): void {
  useAppStore.setState((state) => {
    if (
      state.pendingExplorerReveal &&
      isPathEqualOrDescendant(state.pendingExplorerReveal.filePath, deletedPath)
    ) {
      return { pendingExplorerReveal: null }
    }
    return state
  })
}
