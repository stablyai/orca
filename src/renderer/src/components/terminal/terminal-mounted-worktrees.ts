import type { Worktree } from '../../../../shared/types'

export type TerminalMountedWorktreeSnapshot = {
  mountedWorktrees: Pick<Worktree, 'id' | 'path'>[]
  worktreeIds: string[]
}

let cachedWorktreesByRepo: Record<string, Worktree[]> | null = null
let cachedMountedIdsKey = ''
let cachedSnapshot: TerminalMountedWorktreeSnapshot = {
  mountedWorktrees: [],
  worktreeIds: []
}

function mountedIdsKey(mountedWorktreeIds: ReadonlySet<string>): string {
  return [...mountedWorktreeIds].sort().join('\0')
}

function sameWorktreeProjection(
  left: Pick<Worktree, 'id' | 'path'>[],
  right: Pick<Worktree, 'id' | 'path'>[]
): boolean {
  return (
    left.length === right.length &&
    left.every((worktree, index) => {
      const other = right[index]
      return worktree.id === other.id && worktree.path === other.path
    })
  )
}

export function getTerminalMountedWorktreeSnapshot(
  worktreesByRepo: Record<string, Worktree[]>,
  mountedWorktreeIds: ReadonlySet<string>
): TerminalMountedWorktreeSnapshot {
  const nextMountedIdsKey = mountedIdsKey(mountedWorktreeIds)
  if (worktreesByRepo === cachedWorktreesByRepo && nextMountedIdsKey === cachedMountedIdsKey) {
    return cachedSnapshot
  }

  const mountedWorktrees: Pick<Worktree, 'id' | 'path'>[] = []
  const worktreeIds: string[] = []
  for (const repoWorktrees of Object.values(worktreesByRepo)) {
    for (const worktree of repoWorktrees) {
      worktreeIds.push(worktree.id)
      if (mountedWorktreeIds.has(worktree.id)) {
        mountedWorktrees.push({ id: worktree.id, path: worktree.path })
      }
    }
  }

  cachedWorktreesByRepo = worktreesByRepo
  cachedMountedIdsKey = nextMountedIdsKey
  if (
    worktreeIds.length === cachedSnapshot.worktreeIds.length &&
    worktreeIds.every((id, index) => id === cachedSnapshot.worktreeIds[index]) &&
    sameWorktreeProjection(mountedWorktrees, cachedSnapshot.mountedWorktrees)
  ) {
    return cachedSnapshot
  }

  // Why: Terminal only needs all IDs for pruning plus id/path for mounted pane
  // trees. Preserve the snapshot when unrelated or unmounted worktree metadata
  // changes so sidebar/status refreshes don't rerender xterm during typing.
  cachedSnapshot = { mountedWorktrees, worktreeIds }
  return cachedSnapshot
}
