import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

// Both cycle members and their dependents must survive; independent branches can proceed.
export function getBlockedDeletionDependencies(
  dependencies: ReadonlyMap<string, readonly Pick<Worktree, 'id' | 'hostId'>[]>
): Set<string> {
  const visiting = new Set<string>()
  const results = new Map<string, boolean>()
  const reachesCycle = (identity: string): boolean => {
    if (visiting.has(identity)) {
      return true
    }
    const cached = results.get(identity)
    if (cached !== undefined) {
      return cached
    }
    visiting.add(identity)
    const blocked = (dependencies.get(identity) ?? []).some((child) =>
      reachesCycle(getWorktreeHostIdentity(child))
    )
    visiting.delete(identity)
    results.set(identity, blocked)
    return blocked
  }
  return new Set([...dependencies.keys()].filter(reachesCycle))
}
