import { useAppStore } from '@/store'
import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { sortDirEntries } from '../../../../shared/file-name-sort'
import { readRuntimeDirectory } from '@/runtime/runtime-file-mutation-client'
import type { DirCache, FileExplorerOperationOwner, TreeNode } from './file-explorer-types'
import { shouldIncludeFileExplorerEntry } from './file-explorer-entries'
import { parentDirForWatchPath, resolveCachedDirPath } from './file-explorer-watch-path'
import {
  getFileExplorerOperationOwner,
  getFileExplorerOwnerUnresolvedMessage,
  getFileExplorerOperationRoute
} from './file-explorer-operation-owner'

export type FileExplorerDirectoryListing = {
  entries: DirEntry[]
  operationOwner: FileExplorerOperationOwner
}

export function fileExplorerEntriesToTreeNodes(
  entries: DirEntry[],
  dirPath: string,
  depth: number,
  worktreePath: string | null,
  operationOwner: FileExplorerOperationOwner
): TreeNode[] {
  return entries.filter(shouldIncludeFileExplorerEntry).map((entry) => {
    const path = joinPath(dirPath, entry.name)
    return {
      name: entry.name,
      path,
      relativePath: getRelativePathInsideRoot(path, worktreePath) ?? entry.name,
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
      depth: depth + 1,
      operationOwner
    }
  })
}

// Without followSymlinks, re-reading a parent lists opened folder links as files (#29069).
export function keepOpenedDirectoryLinks(
  previousChildren: readonly TreeNode[] | undefined,
  nextChildren: TreeNode[],
  dirCache: Readonly<Record<string, DirCache>>
): TreeNode[] {
  const openedLinks = new Map<string, string>()
  for (const child of previousChildren ?? []) {
    const cachedLink = dirCache[child.path]
    // Why: pending/failed reads and listings from another host aren't proof of an opened folder.
    if (
      child.isSymlink &&
      child.isDirectory &&
      child.operationOwner &&
      child.operationOwner.kind !== 'unresolved' &&
      cachedLink?.operationOwner &&
      cachedLink.error === undefined &&
      JSON.stringify(child.operationOwner) === JSON.stringify(cachedLink.operationOwner)
    ) {
      openedLinks.set(child.path, JSON.stringify(child.operationOwner))
    }
  }
  if (openedLinks.size === 0) {
    return nextChildren
  }
  return nextChildren.map((child) =>
    child.isSymlink &&
    !child.isDirectory &&
    child.operationOwner !== undefined &&
    openedLinks.get(child.path) === JSON.stringify(child.operationOwner)
      ? { ...child, isDirectory: true, isDirectoryFromOpenedLink: true }
      : child
  )
}

export function clearFailedOpenedDirectoryLink(
  cache: Record<string, DirCache>,
  linkPath: string
): Record<string, DirCache> {
  const parentPath = resolveCachedDirPath(cache, parentDirForWatchPath(linkPath))
  if (!parentPath) {
    return cache
  }
  const parent = cache[parentPath]
  let changed = false
  const children = parent.children.map((child) => {
    if (child.path !== linkPath || !child.isSymlink || !child.isDirectoryFromOpenedLink) {
      return child
    }
    changed = true
    return { ...child, isDirectory: false, isDirectoryFromOpenedLink: false }
  })
  return changed ? { ...cache, [parentPath]: { ...parent, children } } : cache
}

export async function readFileExplorerDirectory(
  activeWorktreeId: string | null | undefined,
  worktreePath: string | null,
  dirPath: string
): Promise<FileExplorerDirectoryListing> {
  const operationOwner = getFileExplorerOperationOwner(activeWorktreeId)
  const route = getFileExplorerOperationRoute(operationOwner)
  if (!route) {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  const entries = await readRuntimeDirectory(
    {
      target: route.target,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId: route.connectionId
    },
    dirPath,
    useAppStore.getState().settings?.followSymlinkedDirectories
      ? { followSymlinks: true }
      : undefined
  )
  // Why: remote-runtime and paired-web routes return the host's order verbatim,
  // and an older host may still sort lexicographically; re-sorting an already
  // sorted local listing is near-free (adaptive sort).
  return {
    entries: sortDirEntries(entries),
    operationOwner
  }
}
