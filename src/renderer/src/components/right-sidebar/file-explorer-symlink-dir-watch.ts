import { useEffect, useMemo, useRef } from 'react'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { DirCache } from './file-explorer-types'

/**
 * Expanded symlink rows, sorted so the set has a stable key. Why not also `isDirectory`: a local
 * listing reports every link as file-shaped, and a parent refresh drops the flag set on expand.
 */
export function selectExpandedSymlinkDirPaths(
  dirCache: Record<string, DirCache>,
  expanded: ReadonlySet<string>
): string[] {
  const paths: string[] = []
  if (expanded.size === 0) {
    return paths
  }
  for (const dir of Object.values(dirCache)) {
    for (const child of dir.children) {
      if (child.isSymlink && expanded.has(child.path)) {
        paths.push(child.path)
      }
    }
  }
  return paths.sort()
}

/**
 * Re-labels a payload from a symlinked folder's own watch as a payload for the worktree; its event
 * paths already sit under the link path, which is inside the worktree.
 */
export function adoptSymlinkDirWatchPayload(
  payload: FsChangedPayload,
  worktreePath: string,
  watchedLinkPaths: ReadonlyMap<string, string>
): FsChangedPayload {
  return watchedLinkPaths.has(normalizeRuntimePathForComparison(payload.worktreePath))
    ? { ...payload, worktreePath }
    : payload
}

/**
 * Why: the worktree's recursive watch does not descend into a symlinked folder (inotify is armed
 * with IN_DONT_FOLLOW; an FSEvents stream covers only the real path it was created on), so files
 * created inside it never reached the explorer. Each expanded symlinked folder gets its own watch;
 * main resolves the link and reports events under the link path
 * (watcher-event-root-path-rewrite.ts).
 * Local only: SSH and runtime hosts keep their existing single watch.
 */
export function useFileExplorerSymlinkDirWatch(args: {
  enabled: boolean
  dirCache: Record<string, DirCache>
  expanded: ReadonlySet<string>
}): { readonly current: ReadonlyMap<string, string> } {
  const { enabled, dirCache, expanded } = args
  const linkPaths = useMemo(
    () => (enabled ? selectExpandedSymlinkDirPaths(dirCache, expanded) : []),
    [enabled, dirCache, expanded]
  )
  const latestLinkPathsRef = useRef(linkPaths)
  latestLinkPathsRef.current = linkPaths
  // Normalized link path -> the spelling handed to watchWorktree, so unwatch matches it.
  const watchedRef = useRef(new Map<string, string>())
  const linkPathsKey = linkPaths.join('\0')

  useEffect(() => {
    const watched = watchedRef.current
    const next = new Map(
      latestLinkPathsRef.current.map((path) => [normalizeRuntimePathForComparison(path), path])
    )
    for (const [key, path] of watched) {
      if (!next.has(key)) {
        watched.delete(key)
        void window.api.fs.unwatchWorktree({ worktreePath: path })
      }
    }
    for (const [key, path] of next) {
      if (watched.has(key)) {
        continue
      }
      watched.set(key, path)
      void window.api.fs.watchWorktree({ worktreePath: path }).catch((err) => {
        console.warn('[filesystem-watch] failed to watch symlinked folder', {
          path,
          error: err instanceof Error ? err.message : String(err)
        })
      })
    }
  }, [linkPathsKey])

  useEffect(() => {
    const watched = watchedRef.current
    return () => {
      for (const path of watched.values()) {
        void window.api.fs.unwatchWorktree({ worktreePath: path })
      }
      watched.clear()
    }
  }, [])

  return watchedRef
}
