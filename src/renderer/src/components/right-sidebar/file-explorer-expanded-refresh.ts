import type { Dispatch, SetStateAction } from 'react'
import { joinPath, normalizeRelativePath } from '@/lib/path'
import type { DirEntry } from '../../../../shared/types'
import type { DirCache, TreeNode } from './file-explorer-types'
import type { FileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import { shouldIncludeFileExplorerEntry } from './file-explorer-entries'

export type RefreshFileExplorerTreeDir = {
  dirPath: string
  depth: number
}

type RefreshFileExplorerExpandedDirsParams = {
  dirs: RefreshFileExplorerTreeDir[]
  worktreePath: string | null
  dirLoadTracker: FileExplorerDirLoadTracker
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  readDirectory: (dirPath: string) => Promise<DirEntry[]>
  createChildren?: (entries: DirEntry[], dir: RefreshFileExplorerTreeDir) => TreeNode[]
}

function entriesToTreeNodes(
  entries: DirEntry[],
  dirPath: string,
  depth: number,
  worktreePath: string | null
): TreeNode[] {
  return entries.filter(shouldIncludeFileExplorerEntry).map((entry) => {
    const path = joinPath(dirPath, entry.name)
    return {
      name: entry.name,
      path,
      relativePath: worktreePath
        ? normalizeRelativePath(path.slice(worktreePath.length + 1))
        : entry.name,
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
      depth: depth + 1
    }
  })
}

export async function refreshFileExplorerExpandedDirs({
  dirs,
  worktreePath,
  dirLoadTracker,
  setDirCache,
  readDirectory,
  createChildren
}: RefreshFileExplorerExpandedDirsParams): Promise<boolean> {
  if (dirs.length === 0) {
    return true
  }

  const uniqueDirs = Array.from(new Map(dirs.map((dir) => [dir.dirPath, dir])).values())
  const loadTokens = new Map(
    uniqueDirs.map((dir) => [dir.dirPath, dirLoadTracker.begin(dir.dirPath)])
  )

  // Why: expanded refresh can touch many directories; commit the loading and
  // result states in two batched writes so large worktrees stay O(N).
  setDirCache((prev) => {
    const next = { ...prev }
    for (const { dirPath } of uniqueDirs) {
      next[dirPath] = {
        children: prev[dirPath]?.children ?? [],
        loading: true
      }
    }
    return next
  })

  const results = await Promise.all(
    uniqueDirs.map(async ({ dirPath, depth }) => {
      const loadToken = loadTokens.get(dirPath)!
      try {
        const entries = await readDirectory(dirPath)
        if (!dirLoadTracker.isCurrent(loadToken)) {
          return { current: false as const }
        }
        return {
          current: true as const,
          dirPath,
          cache: {
            children: createChildren
              ? createChildren(entries, { dirPath, depth })
              : entriesToTreeNodes(entries, dirPath, depth, worktreePath),
            loading: false
          }
        }
      } catch {
        if (!dirLoadTracker.isCurrent(loadToken)) {
          return { current: false as const }
        }
        return {
          current: true as const,
          dirPath,
          cache: { children: [], loading: false }
        }
      }
    })
  )

  // Why: reads can be superseded before the batch commit; re-check tokens so
  // stale expanded-dir refreshes cannot clobber newer watcher-driven loads.
  const currentResults = results.filter(
    (result): result is Extract<typeof result, { current: true }> =>
      result.current && dirLoadTracker.isCurrent(loadTokens.get(result.dirPath)!)
  )
  if (currentResults.length === 0) {
    return false
  }

  setDirCache((prev) => {
    const next = { ...prev }
    for (const result of currentResults) {
      next[result.dirPath] = result.cache
    }
    return next
  })

  return currentResults.length === uniqueDirs.length
}
