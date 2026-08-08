import type { Dispatch, SetStateAction } from 'react'
import type { FsChangedPayload } from '../../../../shared/types'
import type { DirCache } from './file-explorer-types'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import {
  purgeDirCacheSubtrees,
  purgeExpandedDirsSubtrees,
  clearStalePendingReveal
} from './file-explorer-watcher-reconcile'
import {
  canonicalizeFileExplorerWatchPath,
  createCachedDirPathIndex,
  normalizeExplorerAbsolutePath,
  parentDirForWatchPath,
  resolveCachedDirPath
} from './file-explorer-watch-path'

export type ProcessFileExplorerFsPayloadArgs = {
  payload: FsChangedPayload
  currentWorktreePath: string
  worktreeId: string
  cache: Record<string, DirCache>
  expanded: Set<string>
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  setSelectedPath: Dispatch<SetStateAction<string | null>>
  refreshDir: (dirPath: string) => void
  refreshTree: () => void
}

function cachedDirectoryContainsPath(
  cache: Record<string, DirCache>,
  cachedDirPath: string,
  childPath: string,
  childPathIndexes: Map<string, Set<string>>
): boolean {
  let childPaths = childPathIndexes.get(cachedDirPath)
  if (!childPaths) {
    childPaths = new Set(
      cache[cachedDirPath]?.children.map((child) =>
        normalizeRuntimePathForComparison(child.path)
      ) ?? []
    )
    childPathIndexes.set(cachedDirPath, childPaths)
  }
  return childPaths.has(normalizeRuntimePathForComparison(childPath))
}

export function processFileExplorerFsPayload(args: ProcessFileExplorerFsPayloadArgs): void {
  const {
    payload,
    currentWorktreePath,
    worktreeId,
    cache,
    setDirCache,
    setSelectedPath,
    refreshDir,
    refreshTree
  } = args
  if (
    normalizeRuntimePathForComparison(payload.worktreePath) !==
    normalizeRuntimePathForComparison(currentWorktreePath)
  ) {
    return
  }

  const dirsToRefresh = new Set<string>()
  const childPathIndexes = new Map<string, Set<string>>()
  const cachePathIndex = createCachedDirPathIndex(cache)
  const cachedDirsToPurge = new Set<string>()
  const reconciledRenameSources = new Set<string>()
  let needsFullRefresh = false

  const queueCachedDirPurge = (cachedDir: string | null): void => {
    if (cachedDir) {
      cachedDirsToPurge.add(cachedDir)
    }
  }

  for (const evt of payload.events) {
    if (evt.kind === 'overflow') {
      needsFullRefresh = true
      break
    }

    const normalizedPath = canonicalizeFileExplorerWatchPath(currentWorktreePath, evt.absolutePath)
    if (!normalizedPath) {
      continue
    }

    if (evt.kind === 'delete') {
      // Why: watcher can't report isDirectory for deletes; a dirCache key means it was an expanded dir (design §4.4).
      const cachedDir = resolveCachedDirPath(
        cache,
        normalizedPath,
        currentWorktreePath,
        cachePathIndex
      )
      const wasDirectory = cachedDir !== null

      if (wasDirectory && cachedDir) {
        queueCachedDirPurge(cachedDir)
      }

      clearStalePendingReveal(normalizedPath)

      setSelectedPath((prev) => {
        if (
          prev &&
          normalizeRuntimePathForComparison(prev) ===
            normalizeRuntimePathForComparison(normalizedPath)
        ) {
          return null
        }
        if (prev && wasDirectory && isPathInsideOrEqual(normalizedPath, prev)) {
          return null
        }
        return prev
      })

      const parent = parentDirForWatchPath(normalizedPath)
      const cachedParent = resolveCachedDirPath(cache, parent, currentWorktreePath, cachePathIndex)
      if (cachedParent) {
        dirsToRefresh.add(cachedParent)
      }
    } else if (evt.kind === 'create' || evt.kind === 'rename') {
      // Why: create and rename both change a parent's listing. Rename was
      // previously deferred (#10264) so Explorer stayed stale until focus
      // remounted the tree. Case-insensitive cache lookup covers Windows
      // drive-letter / path casing drift between watcher and worktree path.
      const parent = parentDirForWatchPath(normalizedPath)
      const cachedParent = resolveCachedDirPath(cache, parent, currentWorktreePath, cachePathIndex)
      if (cachedParent) {
        dirsToRefresh.add(cachedParent)
      }
      if (evt.kind === 'rename') {
        const oldPath = evt.oldAbsolutePath
          ? canonicalizeFileExplorerWatchPath(currentWorktreePath, evt.oldAbsolutePath)
          : null
        const cachedOldDir = oldPath
          ? resolveCachedDirPath(cache, oldPath, currentWorktreePath, cachePathIndex)
          : null
        if (oldPath) {
          const oldParent = parentDirForWatchPath(oldPath)
          const cachedOldParent = resolveCachedDirPath(
            cache,
            oldParent,
            currentWorktreePath,
            cachePathIndex
          )
          if (cachedOldParent) {
            dirsToRefresh.add(cachedOldParent)
          }

          const sourceKey = normalizeRuntimePathForComparison(oldPath)
          if (!reconciledRenameSources.has(sourceKey)) {
            reconciledRenameSources.add(sourceKey)
            clearStalePendingReveal(oldPath)
            setSelectedPath((prev) => {
              if (!prev) {
                return prev
              }
              const selectedSource = normalizeRuntimePathForComparison(prev)
              if (selectedSource === sourceKey) {
                return null
              }
              return cachedOldDir && isPathInsideOrEqual(oldPath, prev) ? null : prev
            })
          }
        }

        const cachedNewDir = resolveCachedDirPath(
          cache,
          normalizedPath,
          currentWorktreePath,
          cachePathIndex
        )
        queueCachedDirPurge(cachedOldDir)
        queueCachedDirPurge(cachedNewDir)
      }
    } else if (evt.kind === 'update') {
      const cachedDir = resolveCachedDirPath(
        cache,
        normalizedPath,
        currentWorktreePath,
        cachePathIndex
      )
      if (evt.isDirectory === true && cachedDir) {
        dirsToRefresh.add(cachedDir)
        continue
      }

      const parent = parentDirForWatchPath(normalizedPath)
      const cachedParent = resolveCachedDirPath(cache, parent, currentWorktreePath, cachePathIndex)
      // Windows can classify a new file as update; existing file updates do not invalidate the tree.
      if (
        cachedParent &&
        !dirsToRefresh.has(cachedParent) &&
        !cachedDirectoryContainsPath(cache, cachedParent, normalizedPath, childPathIndexes)
      ) {
        dirsToRefresh.add(cachedParent)
      }
    }
  }

  purgeDirCacheSubtrees(setDirCache, cachedDirsToPurge)
  purgeExpandedDirsSubtrees(worktreeId, cachedDirsToPurge)

  if (needsFullRefresh) {
    refreshTree()
    return
  }

  const rootPath = normalizeExplorerAbsolutePath(currentWorktreePath)
  for (const dirPath of dirsToRefresh) {
    const isRoot =
      normalizeRuntimePathForComparison(dirPath) === normalizeRuntimePathForComparison(rootPath)
    if (isRoot || dirPath in cache) {
      refreshDir(dirPath)
    }
  }
}
