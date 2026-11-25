import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useCallback, useEffect } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { DirCache } from './file-explorer-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { FileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import type { FileExplorerLoadingDirsUpdater } from './file-explorer-dir-load-state'
import { loadMoreFileExplorerDir } from './file-explorer-dir-pages'

/** Read the next page this many rows before a partly listed folder's last row scrolls into view. */
const LOAD_AHEAD_ROWS = 50

/** Partly listed folders whose last listed row is within `LOAD_AHEAD_ROWS` of the rendered range. */
export function fileExplorerDirsDueForMore(
  dirCache: Readonly<Record<string, DirCache>>,
  loadingDirPaths: ReadonlySet<string>,
  rowProjection: Pick<FileExplorerRowProjection, 'getIndexByPath'>,
  renderedEndIndex: number
): string[] {
  const due: string[] = []
  for (const [dirPath, cache] of Object.entries(dirCache)) {
    if (!cache.more || cache.error !== undefined || loadingDirPaths.has(dirPath)) {
      continue
    }
    const last = cache.children.at(-1)
    // A collapsed or filtered-out folder has no row to scroll to, so it waits for expand.
    const lastIndex = last ? rowProjection.getIndexByPath(last.path) : null
    if (lastIndex !== null && lastIndex <= renderedEndIndex + LOAD_AHEAD_ROWS) {
      due.push(dirPath)
    }
  }
  return due
}

/** Lists more of a big remote folder as its end scrolls near, or as soon as it is expanded short. */
export function useFileExplorerLoadMore({
  virtualizer,
  rowProjection,
  dirCache,
  loadingDirPaths,
  loadMoreDir
}: {
  virtualizer: Pick<Virtualizer<HTMLDivElement, Element>, 'range'>
  rowProjection: FileExplorerRowProjection
  dirCache: Record<string, DirCache>
  loadingDirPaths: ReadonlySet<string>
  loadMoreDir: (dirPath: string) => Promise<void>
}): void {
  const renderedEndIndex = virtualizer.range?.endIndex ?? -1
  useEffect(() => {
    if (renderedEndIndex < 0) {
      return
    }
    for (const dirPath of fileExplorerDirsDueForMore(
      dirCache,
      loadingDirPaths,
      rowProjection,
      renderedEndIndex
    )) {
      void loadMoreDir(dirPath)
    }
  }, [renderedEndIndex, dirCache, loadingDirPaths, rowProjection, loadMoreDir])
}

/** The tree's `loadMoreDir`: reads through the tree's own refs so it sees the latest cache. */
export function useFileExplorerLoadMoreDir({
  activeWorktreeId,
  worktreePath,
  dirCacheRef,
  loadingDirPathsRef,
  dirLoadTrackerRef,
  setDirCache,
  updateLoadingDirPaths
}: {
  activeWorktreeId: string | null | undefined
  worktreePath: string | null
  dirCacheRef: RefObject<Record<string, DirCache>>
  loadingDirPathsRef: RefObject<ReadonlySet<string>>
  dirLoadTrackerRef: RefObject<FileExplorerDirLoadTracker>
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  updateLoadingDirPaths: FileExplorerLoadingDirsUpdater
}): (dirPath: string) => Promise<void> {
  return useCallback(
    (dirPath: string) =>
      loadMoreFileExplorerDir({
        dirPath,
        activeWorktreeId,
        worktreePath,
        dirCache: dirCacheRef.current,
        loadingDirPaths: loadingDirPathsRef.current,
        dirLoadTracker: dirLoadTrackerRef.current,
        setDirCache,
        updateLoadingDirPaths
      }),
    [
      activeWorktreeId,
      worktreePath,
      dirCacheRef,
      loadingDirPathsRef,
      dirLoadTrackerRef,
      setDirCache,
      updateLoadingDirPaths
    ]
  )
}
