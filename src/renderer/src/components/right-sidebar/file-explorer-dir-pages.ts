import type { Dispatch, SetStateAction } from 'react'
import { sortDirEntries } from '../../../../shared/file-name-sort'
import type { DirCache } from './file-explorer-types'
import type { FileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import {
  fileExplorerEntriesToTreeNodes,
  readFileExplorerDirectory,
  type FileExplorerDirectoryListing
} from './file-explorer-directory-listing'
import { splitPathSegments } from './path-tree'
import { dirname } from '@/lib/path'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import { describeFileExplorerReadError } from './file-explorer-read-error'
import {
  clearFileExplorerDirsLoading,
  markFileExplorerDirsLoading,
  type FileExplorerLoadingDirsUpdater
} from './file-explorer-dir-load-state'

export function fileExplorerDirDepth(worktreePath: string | null, dirPath: string): number {
  return !worktreePath || dirPath === worktreePath
    ? -1
    : splitPathSegments(dirPath.slice(worktreePath.length + 1)).length - 1
}

export function fileExplorerListingToDirCache(
  listing: FileExplorerDirectoryListing,
  dirPath: string,
  depth: number,
  worktreePath: string | null
): DirCache {
  return {
    children: fileExplorerEntriesToTreeNodes(
      listing.entries,
      dirPath,
      depth,
      worktreePath,
      listing.operationOwner,
      listing.outsideProject === true
    ),
    operationOwner: listing.operationOwner,
    ...(listing.more ? { more: listing.more } : {}),
    ...(listing.paged ? { paged: true } : {}),
    ...(listing.outsideProject ? { outsideProject: true } : {})
  }
}

/** Adds a further page after the rows already listed; a row the watcher already added stays once. */
export function appendFileExplorerDirPage(
  cache: DirCache,
  page: FileExplorerDirectoryListing,
  dirPath: string,
  depth: number,
  worktreePath: string | null
): DirCache {
  const { more: _listedMore, ...listed } = cache
  // A page from another host than the rows above it cannot extend them.
  if (JSON.stringify(cache.operationOwner) !== JSON.stringify(page.operationOwner)) {
    return listed
  }
  const known = new Set(cache.children.map((child) => child.path))
  const added = fileExplorerListingToDirCache(page, dirPath, depth, worktreePath).children.filter(
    (child) => !known.has(child.path)
  )
  return {
    ...listed,
    children: sortDirEntries([...cache.children, ...added]),
    ...(page.more ? { more: page.more } : {})
  }
}

/** The partly listed folder a reveal must read on in, because its next path is not listed yet. */
export function fileExplorerRevealDirToReadOn(
  dirCache: Readonly<Record<string, DirCache>>,
  rowProjection: Pick<FileExplorerRowProjection, 'hasPath'>,
  revealPaths: readonly string[]
): string | null {
  const unlisted = revealPaths.find((path) => !rowProjection.hasPath(path))
  if (unlisted === undefined) {
    return null
  }
  const parent = dirCache[dirname(unlisted)]
  return parent?.more && parent.error === undefined ? dirname(unlisted) : null
}

export type LoadMoreFileExplorerDirParams = {
  dirPath: string
  activeWorktreeId: string | null | undefined
  worktreePath: string | null
  dirCache: Readonly<Record<string, DirCache>>
  loadingDirPaths: ReadonlySet<string>
  dirLoadTracker: FileExplorerDirLoadTracker
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  updateLoadingDirPaths: FileExplorerLoadingDirsUpdater
}

/** Reads the next page of a partly listed folder; a refresh or reset started meanwhile wins. */
export async function loadMoreFileExplorerDir({
  dirPath,
  activeWorktreeId,
  worktreePath,
  dirCache,
  loadingDirPaths,
  dirLoadTracker,
  setDirCache,
  updateLoadingDirPaths
}: LoadMoreFileExplorerDirParams): Promise<void> {
  const more = dirCache[dirPath]?.more
  if (!more || dirCache[dirPath]?.error !== undefined || loadingDirPaths.has(dirPath)) {
    return
  }
  const loadToken = dirLoadTracker.begin(dirPath)
  updateLoadingDirPaths((prev) => markFileExplorerDirsLoading(prev, [dirPath]))
  try {
    const page = await readFileExplorerDirectory(activeWorktreeId, worktreePath, dirPath, {
      paged: true,
      after: more.after
    })
    if (!dirLoadTracker.isCurrent(loadToken)) {
      return
    }
    setDirCache((prev) =>
      prev[dirPath]
        ? {
            ...prev,
            [dirPath]: appendFileExplorerDirPage(
              prev[dirPath],
              page,
              dirPath,
              fileExplorerDirDepth(worktreePath, dirPath),
              worktreePath
            )
          }
        : prev
    )
  } catch (error) {
    if (!dirLoadTracker.isCurrent(loadToken)) {
      return
    }
    // Why an error mark: it stops scrolling from retrying a failing host until the next refresh.
    setDirCache((prev) =>
      prev[dirPath]
        ? { ...prev, [dirPath]: { ...prev[dirPath], error: describeFileExplorerReadError(error) } }
        : prev
    )
  }
  updateLoadingDirPaths((prev) => clearFileExplorerDirsLoading(prev, [dirPath]))
}
