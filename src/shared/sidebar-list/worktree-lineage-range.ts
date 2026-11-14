import type { WorktreeOccurrencePlan } from '../worktree-occurrence-plan'
import type { Worktree } from '../worktree/types'
import {
  getWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../worktree/host-qualified-identity'

export type WorktreeLineageTree = {
  identities: HostScopedWorktreeKey[]
  worktrees: Worktree[]
  ends: number[]
  /**
   * Indices whose row was replaced in place, one entry per plan that replaced any. Readers
   * remember how many entries they have seen and re-read only the indices added since.
   */
  replacedRows?: number[][]
}

/** Past this many in-place replacements a section rebuilds its tree, bounding the journal. */
const MAX_ROW_REPLACEMENTS = 256

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

const rangesByPlan = new WeakMap<
  WorktreeOccurrencePlan<Worktree>,
  Map<string, WorktreeLineageRange>
>()

let previousPlan: WorktreeOccurrencePlan<Worktree> | undefined

/** One preorder table per section; ranges share it instead of copying every ancestor's subtree. */
export function buildWorktreeLineageRanges(
  plan: WorktreeOccurrencePlan<Worktree>
): Map<string, WorktreeLineageRange> {
  const cached = rangesByPlan.get(plan)
  if (cached) {
    return cached
  }
  const result = new Map<string, WorktreeLineageRange>()
  const previousRanges = previousPlan ? rangesByPlan.get(previousPlan) : undefined
  for (const [sectionKey, occurrences] of plan.bySection) {
    const previous = previousPlan?.bySection.get(sectionKey)
    const previousTree = previous?.[0] && previousRanges?.get(previous[0].key)?.tree
    // Review/group labels and row replacements (unread, activity) rebuild the plan without
    // changing its lineage: same order, depth and identities keep the tree and its ranges.
    if (
      previous &&
      previousRanges &&
      previousTree &&
      previous.length === occurrences.length &&
      (previousTree.replacedRows?.length ?? 0) < MAX_ROW_REPLACEMENTS &&
      occurrences.every((occurrence, index) => {
        const before = previous[index]!
        return (
          before.depth === occurrence.depth &&
          before.key === occurrence.key &&
          (before.row === occurrence.row ||
            previousTree.identities[index] === getWorktreeHostIdentity(occurrence.row))
        )
      })
    ) {
      const replaced: number[] = []
      occurrences.forEach((occurrence, index) => {
        if (previousTree.worktrees[index] !== occurrence.row) {
          previousTree.worktrees[index] = occurrence.row
          replaced.push(index)
        }
      })
      if (replaced.length > 0) {
        ;(previousTree.replacedRows ??= []).push(replaced)
      }
      for (const { key } of occurrences) {
        result.set(key, previousRanges.get(key)!)
      }
      continue
    }
    const tree: WorktreeLineageTree = {
      identities: [],
      worktrees: [],
      ends: []
    }
    const stack: number[] = []
    occurrences.forEach((occurrence, index) => {
      while (stack.length && occurrences[stack.at(-1)!]!.depth >= occurrence.depth) {
        tree.ends[stack.pop()!] = index
      }
      tree.identities.push(getWorktreeHostIdentity(occurrence.row))
      tree.worktrees.push(occurrence.row)
      stack.push(index)
    })
    for (const index of stack) {
      tree.ends[index] = occurrences.length
    }
    occurrences.forEach((occurrence, index) => {
      const range = { tree, index, length: tree.ends[index]! - index - 1 }
      result.set(occurrence.key, range)
    })
  }
  rangesByPlan.set(plan, result)
  previousPlan = plan
  return result
}
