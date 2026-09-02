import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../shared/worktree/types'

export function buildWorktreeJumpPaletteWorktreeMaps(worktrees: readonly Worktree[]): {
  worktreeMap: Map<string, Worktree>
  worktreeOrder: Map<string, number>
} {
  const worktreeMap = new Map<string, Worktree>()
  for (const worktree of worktrees) {
    // Keep a host-qualified map for consumers that only have an identity key.
    worktreeMap.set(getWorktreeHostIdentity(worktree), worktree)
    if (!worktreeMap.has(worktree.id)) {
      worktreeMap.set(worktree.id, worktree)
    }
  }
  const worktreeOrder = new Map(
    worktrees.map((worktree, index) => [getWorktreeHostIdentity(worktree), index])
  )
  return { worktreeMap, worktreeOrder }
}
