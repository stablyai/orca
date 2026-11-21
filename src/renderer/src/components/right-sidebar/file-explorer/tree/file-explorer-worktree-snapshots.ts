import type { DirCache } from './file-explorer-types'

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

// The id keeps a local and a remote workspace at the same path apart.
export function fileExplorerWorktreeSnapshotKey(
  worktreeId: string | null | undefined,
  worktreePath: string
): string {
  return JSON.stringify([worktreeId ?? null, worktreePath])
}

/** The workspace a tree's listings were read for. */
export type FileExplorerTreeOwner = { key: string; rootPath: string }

const treeSnapshots = createFileExplorerWorktreeSnapshots<Record<string, DirCache>>()

export function fileExplorerTreeOwner(
  worktreeId: string | null | undefined,
  worktreePath: string | null
): FileExplorerTreeOwner | null {
  return worktreePath
    ? { key: fileExplorerWorktreeSnapshotKey(worktreeId, worktreePath), rootPath: worktreePath }
    : null
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
  if (leaving?.key !== next?.key) {
    keepFileExplorerTree(leaving, leavingCache)
  }
  return next ? treeSnapshots.take(next.key) : undefined
}
