import { shallow } from 'zustand/shallow'
import type { Worktree } from '../../../../../shared/worktree/types'
import { getPaletteWorktreeIdentity } from '@/lib/workspace/search/palette-repo-resolution'
import { EMPTY_SORTED_WORKTREES } from '../worktree-jump-palette-model'

export function createPaletteWorktreeArrayReuse() {
  let previous: readonly Worktree[] = EMPTY_SORTED_WORKTREES
  return (next: readonly Worktree[]) => {
    if (!shallow(previous, next)) {
      previous = next
    }
    return previous
  }
}

export function buildWorktreeJumpPaletteWorktreeMaps(worktrees: readonly Worktree[]): {
  worktreeMap: Map<string, Worktree>
  worktreeOrder: Map<string, number>
} {
  const worktreeMap = new Map<string, Worktree>()
  for (const worktree of worktrees) {
    // Keep a host-qualified map for consumers that only have an identity key.
    worktreeMap.set(getPaletteWorktreeIdentity(worktree), worktree)
    if (!worktreeMap.has(worktree.id)) {
      worktreeMap.set(worktree.id, worktree)
    }
  }
  const worktreeOrder = new Map(
    worktrees.map((worktree, index) => [getPaletteWorktreeIdentity(worktree), index])
  )
  return { worktreeMap, worktreeOrder }
}
