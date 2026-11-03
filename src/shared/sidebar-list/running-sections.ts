import type { Worktree } from '../worktree/types'
import type { WorktreeGroupEntry } from './worktree-group-entry'

/** Whether a project section has a live terminal; undefined when the reader has no liveness. */
export function createRunningSectionTest(
  worktrees: readonly Worktree[],
  runningWorktreeIds: ReadonlySet<string> | undefined
): ((group: WorktreeGroupEntry) => boolean) | undefined {
  if (!runningWorktreeIds) {
    return undefined
  }
  // Why all visible worktrees: pinned ones and their lineage leave group.items but still run there.
  const runningRepoIds = new Set(
    worktrees.filter((worktree) => runningWorktreeIds.has(worktree.id)).map((w) => w.repoId)
  )
  return (group) =>
    [...group.repoIds].some((repoId) => runningRepoIds.has(repoId)) ||
    group.items.some((worktree) => runningRepoIds.has(worktree.repoId))
}
