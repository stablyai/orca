import type { WorktreeOccurrencePlan } from '../worktree-occurrence-plan'
import type { Worktree } from '../worktree/types'
import {
  getWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../worktree/host-qualified-identity'

export type WorktreeLineageTree = {
  identities: HostScopedWorktreeKey[]
  worktrees: Worktree[]
  parents: number[]
  ends: number[]
  indexByIdentity: Map<HostScopedWorktreeKey, number>
  indexByWorktreeId: Map<string, number | null>
  rangesByOccurrence: Map<string, WorktreeLineageRange>
}

export type WorktreeLineageRange = {
  tree: WorktreeLineageTree
  index: number
  length: number
}

export type WorktreeLineageSource = readonly HostScopedWorktreeKey[] | WorktreeLineageRange

export function isLineageRange(source: WorktreeLineageSource): source is WorktreeLineageRange {
  return 'tree' in source
}

export function* lineageIdentities(source: WorktreeLineageSource): Iterable<HostScopedWorktreeKey> {
  if (!isLineageRange(source)) {
    yield* source
    return
  }
  for (let i = source.index + 1; i < source.tree.ends[source.index]!; i++) {
    yield source.tree.identities[i]!
  }
}

/** One preorder table per section; ranges share it instead of copying every ancestor's subtree. */
export function buildWorktreeLineageRanges(
  plan: WorktreeOccurrencePlan<Worktree>
): Map<string, WorktreeLineageRange> {
  const result = new Map<string, WorktreeLineageRange>()
  for (const occurrences of plan.bySection.values()) {
    const tree: WorktreeLineageTree = {
      identities: [],
      worktrees: [],
      parents: [],
      ends: [],
      indexByIdentity: new Map(),
      indexByWorktreeId: new Map(),
      rangesByOccurrence: result
    }
    const stack: number[] = []
    occurrences.forEach((occurrence, index) => {
      while (stack.length && occurrences[stack.at(-1)!]!.depth >= occurrence.depth) {
        tree.ends[stack.pop()!] = index
      }
      tree.parents.push(stack.at(-1) ?? -1)
      tree.identities.push(getWorktreeHostIdentity(occurrence.row))
      tree.worktrees.push(occurrence.row)
      tree.indexByIdentity.set(getWorktreeHostIdentity(occurrence.row), index)
      tree.indexByWorktreeId.set(
        occurrence.row.id,
        tree.indexByWorktreeId.has(occurrence.row.id) ? null : index
      )
      stack.push(index)
    })
    for (const index of stack) {
      tree.ends[index] = occurrences.length
    }
    occurrences.forEach((occurrence, index) => {
      result.set(occurrence.key, { tree, index, length: tree.ends[index]! - index - 1 })
    })
  }
  return result
}
