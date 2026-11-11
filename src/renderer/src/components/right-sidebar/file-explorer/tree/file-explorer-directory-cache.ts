import type { DirCache } from './file-explorer-types'

export type FileExplorerDirCacheUpdate = {
  dirCache: Record<string, DirCache>
  changedPaths: readonly string[]
  sourceWorkspaceId?: string | null
  reset?: true
}
export type FileExplorerDirCacheSetter = (
  update: (previous: Record<string, DirCache>) => FileExplorerDirCacheUpdate
) => void
export type FileExplorerDirectorySnapshot = {
  dirCache: Record<string, DirCache>
  sourceWorkspaceId: string | null
}
export type FileExplorerDirectoryCommit = FileExplorerDirectorySnapshot & {
  changedPaths: readonly string[]
  reset: boolean
}

/** Directory mutations publish their own addresses; rendering never owns their commit lifetime. */
export class FileExplorerDirectoryCache {
  private snapshot: FileExplorerDirectorySnapshot = { dirCache: {}, sourceWorkspaceId: null }
  readonly cacheRef = { current: this.snapshot.dirCache }
  private listeners = new Set<() => void>()
  private changeListeners = new Set<(commit: FileExplorerDirectoryCommit) => void>()
  private notifying = false
  private queued: Parameters<FileExplorerDirCacheSetter>[0][] = []

  getSnapshot = (): FileExplorerDirectorySnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeChanges = (listener: (commit: FileExplorerDirectoryCommit) => void): (() => void) => {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  update: FileExplorerDirCacheSetter = (update) => {
    this.queued.push(update)
    if (this.notifying) {
      return
    }
    this.notifying = true
    try {
      for (let index = 0; index < this.queued.length; index++) {
        const previous = this.snapshot
        const result = this.queued[index](previous.dirCache)
        const sourceWorkspaceId =
          result.sourceWorkspaceId === undefined
            ? previous.sourceWorkspaceId
            : result.sourceWorkspaceId
        const reset = result.reset === true || sourceWorkspaceId !== previous.sourceWorkspaceId
        const changedPaths = [...new Set(result.changedPaths)].filter(
          (path) => previous.dirCache[path] !== result.dirCache[path]
        )
        if (!reset && changedPaths.length === 0) {
          continue
        }
        this.snapshot = { dirCache: result.dirCache, sourceWorkspaceId }
        this.cacheRef.current = result.dirCache
        const commit = { ...this.snapshot, changedPaths, reset }
        for (const listener of this.changeListeners) {
          listener(commit)
        }
        for (const listener of this.listeners) {
          listener()
        }
      }
    } finally {
      this.queued = []
      this.notifying = false
    }
  }
}

export function markFileExplorerDirectory(
  previous: Record<string, DirCache>,
  path: string
): FileExplorerDirCacheUpdate {
  const changedPaths: string[] = []
  const next: Record<string, DirCache> = {}
  for (const [dirPath, cache] of Object.entries(previous)) {
    let changed = false
    const children = cache.children.map((child) => {
      if (child.path !== path || child.isDirectory) {
        return child
      }
      changed = true
      return { ...child, isDirectory: true, isDirectoryFromOpenedLink: child.isSymlink === true }
    })
    if (changed) {
      changedPaths.push(dirPath)
    }
    next[dirPath] = changed ? { ...cache, children } : cache
  }
  return { dirCache: changedPaths.length ? next : previous, changedPaths }
}
