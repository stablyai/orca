import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../shared/worktree/types'

type WorktreeIdentity = Pick<Worktree, 'id' | 'hostId'>

export function createHostQualifiedWorktreeStateReader<T>(
  worktrees: readonly WorktreeIdentity[],
  stateByWorktree: Readonly<Record<string, T | undefined>>
): (worktree: WorktreeIdentity) => T | undefined {
  const seenIds = new Set<string>()
  const ambiguousIds = new Set<string>()
  for (const worktree of worktrees) {
    if (seenIds.has(worktree.id)) {
      ambiguousIds.add(worktree.id)
    }
    seenIds.add(worktree.id)
  }

  return (worktree) => {
    const qualified = stateByWorktree[getWorktreeHostIdentity(worktree)]
    if (qualified !== undefined) {
      return qualified
    }
    return ambiguousIds.has(worktree.id) ? undefined : stateByWorktree[worktree.id]
  }
}
