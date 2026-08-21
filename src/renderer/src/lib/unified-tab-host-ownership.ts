import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

export function findAmbiguousWorktreeIds(
  worktrees: readonly Pick<Worktree, 'id'>[]
): ReadonlySet<string> {
  const seen = new Set<string>()
  const ambiguous = new Set<string>()
  for (const worktree of worktrees) {
    if (seen.has(worktree.id)) {
      ambiguous.add(worktree.id)
    }
    seen.add(worktree.id)
  }
  return ambiguous
}

export function isUnifiedTabOwnedByWorktree(
  tab: Pick<Tab, 'executionHostId' | 'worktreeId'> | undefined,
  worktree: Pick<Worktree, 'hostId' | 'id'>,
  ambiguousWorktreeIds: ReadonlySet<string>
): boolean {
  if (tab?.executionHostId) {
    return (
      tab.worktreeId === worktree.id &&
      tab.executionHostId === (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID)
    )
  }
  return !ambiguousWorktreeIds.has(worktree.id)
}
