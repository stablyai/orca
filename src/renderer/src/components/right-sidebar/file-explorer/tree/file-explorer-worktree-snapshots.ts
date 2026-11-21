import { useAppStore } from '@/store/index'
import { getFileExplorerOperationOwner } from '../navigation/file-explorer-operation-owner'
import type { DirCache, FileExplorerTreeRefreshOptions } from './file-explorer-types'

// Bounds what Files keeps for workspaces it is not showing: the few most recent, listings only.
const MAX_WORKTREE_SNAPSHOTS = 4

export type FileExplorerWorktreeSnapshots<T> = {
  keep: (key: string, value: T) => void
  peek: (key: string) => T | undefined
  take: (key: string) => T | undefined
}

/** Outlives the Files panel so a return paints the last answer while the panel revalidates it. */
export function createFileExplorerWorktreeSnapshots<T>(): FileExplorerWorktreeSnapshots<T> {
  const snapshots = new Map<string, T>()
  return {
    keep: (key, value) => {
      snapshots.delete(key)
      snapshots.set(key, value)
      for (const oldest of snapshots.keys()) {
        if (snapshots.size <= MAX_WORKTREE_SNAPSHOTS) {
          break
        }
        snapshots.delete(oldest)
      }
    },
    peek: (key) => snapshots.get(key),
    take: (key) => {
      const value = snapshots.get(key)
      snapshots.delete(key)
      return value
    }
  }
}

// The operation owner keeps folder twins on different hosts apart, as FileExplorer's own key does.
export function fileExplorerWorktreeSnapshotKey(
  worktreeId: string | null | undefined,
  worktreePath: string
): string {
  return JSON.stringify([
    worktreeId ?? null,
    worktreePath,
    getFileExplorerOperationOwner(worktreeId)
  ])
}

/** The workspace a tree's listings were read for. */
export type FileExplorerTreeOwner = { key: string; rootPath: string }

const treeSnapshots = createFileExplorerWorktreeSnapshots<Record<string, DirCache>>()

export function fileExplorerTreeOwner(
  worktreeId: string | null | undefined,
  worktreePath: string | null
): FileExplorerTreeOwner | null {
  if (!worktreePath) {
    return null
  }
  // Followed folder links survive rereads, so a tree listed under the other setting is not reused.
  const followSymlinks = useAppStore.getState().settings?.followSymlinkedDirectories ?? false
  return {
    key: JSON.stringify([
      fileExplorerWorktreeSnapshotKey(worktreeId, worktreePath),
      followSymlinks
    ]),
    rootPath: worktreePath
  }
}

/** Keeps a tree whose root listed; a pending or failed root has nothing worth repainting. */
export function keepFileExplorerTree(
  owner: FileExplorerTreeOwner | null,
  dirCache: Record<string, DirCache>
): void {
  const root = owner ? dirCache[owner.rootPath] : undefined
  if (owner && root && root.children.length > 0 && !root.error) {
    treeSnapshots.keep(owner.key, dirCache)
  }
}

/** Keeps the tree being left for another workspace and hands back the next one's last listings. */
export function switchFileExplorerTree(
  leaving: FileExplorerTreeOwner | null,
  leavingCache: Record<string, DirCache>,
  next: FileExplorerTreeOwner | null
): Record<string, DirCache> | undefined {
  // Taken first so keeping the departing tree cannot evict the one being returned to.
  const restored = next ? treeSnapshots.take(next.key) : undefined
  if (leaving?.key !== next?.key) {
    keepFileExplorerTree(leaving, leavingCache)
  }
  return restored
}

/** Expanded folders a tree refresh rereads; the root is read on its own first. */
export function foldersToRecheck(
  expanded: ReadonlySet<string>,
  rootPath: string,
  dirCache: Readonly<Record<string, DirCache>>,
  options: FileExplorerTreeRefreshOptions | undefined
): string[] {
  // On a restore the expansion effect reads unlisted and empty folders (decideExpandedDirLoad).
  return Array.from(expanded).filter(
    (dirPath) =>
      dirPath !== rootPath &&
      (!options?.restoredSnapshot || Boolean(dirCache[dirPath]?.children.length))
  )
}
