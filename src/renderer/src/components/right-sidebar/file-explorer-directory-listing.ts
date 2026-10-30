import { useAppStore } from '@/store'
import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { sortDirEntries } from '../../../../shared/file-name-sort'
import {
  readRuntimeDirectoryPage,
  runtimeDirectoryPagesSupported
} from '@/runtime/runtime-directory-page-client'
import { readRuntimeDirectory } from '@/runtime/runtime-file-mutation-client'
import {
  FILE_READ_DIR_MAX_PAGE_ENTRIES,
  isDirListingTooLargeForRemoteError,
  type DirEntryCursor
} from '../../../../shared/file-dir-page'
import type {
  DirCache,
  FileExplorerDirMore,
  FileExplorerOperationOwner,
  TreeNode
} from './file-explorer-types'
import { shouldIncludeFileExplorerEntry } from './file-explorer-entries'
import { parentDirForWatchPath, resolveCachedDirPath } from './file-explorer-watch-path'
import {
  getFileExplorerOperationOwner,
  getFileExplorerOwnerUnresolvedMessage,
  getFileExplorerOperationRoute
} from './file-explorer-operation-owner'

/** Entries per page of a folder too big for one remote reply; smaller folders still list whole. */
export const FILE_EXPLORER_DIR_PAGE_ENTRIES = FILE_READ_DIR_MAX_PAGE_ENTRIES

export type FileExplorerDirectoryListing = {
  entries: DirEntry[]
  operationOwner: FileExplorerOperationOwner
  more?: FileExplorerDirMore
  paged?: true
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
    const workspaceRelativePath = getRelativePathInsideRoot(path, worktreePath)
    return {
      name: entry.name,
      path,
      relativePath: workspaceRelativePath ?? path,
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
    // Failed/pending reads and other-host listings do not prove a folder link was opened.
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

/**
 * Lists `dirPath` whole, as always. Only a remote folder too big for one reply is listed in pages:
 * from just after `after` until at least `minEntries` are read, so a refresh does not shrink the tree.
 */
export async function readFileExplorerDirectory(
  activeWorktreeId: string | null | undefined,
  worktreePath: string | null,
  dirPath: string,
  options: {
    wakeWslDistro?: boolean
    paged?: boolean
    after?: DirEntryCursor
    minEntries?: number
  } = {}
): Promise<FileExplorerDirectoryListing> {
  const operationOwner = getFileExplorerOperationOwner(activeWorktreeId)
  const route = getFileExplorerOperationRoute(operationOwner)
  if (!route) {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  const context = {
    target: route.target,
    worktreeId: activeWorktreeId,
    worktreePath,
    connectionId: route.connectionId
  }
  const outsideWorkspace = getRelativePathInsideRoot(dirPath, worktreePath) === null
  const readOptions = {
    ...(useAppStore.getState().settings?.followSymlinkedDirectories
      ? { followSymlinks: true }
      : {}),
    ...(outsideWorkspace ? { access: { kind: 'user-directory' as const } } : {}),
    ...(options.wakeWslDistro === undefined ? {} : { wakeWslDistro: options.wakeWslDistro })
  }
  if (!options.paged && !options.after) {
    try {
      // Older remote hosts may return lexical order; adaptive sorting keeps already-sorted local listings cheap.
      const whole = await readRuntimeDirectory(context, dirPath, readOptions)
      return { entries: sortDirEntries(whole), operationOwner }
    } catch (error) {
      if (
        !isDirListingTooLargeForRemoteError(error) ||
        !runtimeDirectoryPagesSupported(context, dirPath)
      ) {
        throw error
      }
    }
  }
  const wanted = Math.max(options.minEntries ?? 0, FILE_EXPLORER_DIR_PAGE_ENTRIES)
  let entries: DirEntry[] = []
  let after = options.after
  let hasMore: boolean
  do {
    const page = await readRuntimeDirectoryPage(
      context,
      dirPath,
      { ...(after ? { after } : {}), limit: FILE_EXPLORER_DIR_PAGE_ENTRIES },
      readOptions
    )
    entries = entries.length === 0 ? page.entries : entries.concat(page.entries)
    const last = page.entries.at(-1)
    hasMore = page.hasMore && last !== undefined
    after = last ? { name: last.name, isDirectory: last.isDirectory } : after
  } while (hasMore && entries.length < wanted)
  return {
    entries: sortDirEntries(entries),
    operationOwner,
    paged: true,
    ...(hasMore && after ? { more: { after } } : {})
  }
}
