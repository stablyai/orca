import type { WorktreeOccurrencePlan } from './lineage/worktree-occurrence-plan'
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
const sectionTreesByPlan = new WeakMap<
  WorktreeOccurrencePlan<Worktree>,
  Map<string, WorktreeLineageTree>
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
  const sectionTrees = new Map<string, WorktreeLineageTree>()
  const previousRanges = previousPlan ? rangesByPlan.get(previousPlan) : undefined
  const previousTrees = previousPlan ? sectionTreesByPlan.get(previousPlan) : undefined
  for (const [sectionKey, occurrences] of plan.bySection) {
    let hasLineage = false
    for (const occurrence of occurrences) {
      if (occurrence.childCount > 0 || occurrence.depth > 0) {
        hasLineage = true
        break
      }
    }
    if (!hasLineage) {
      continue
    }
    const previous = previousPlan?.bySection.get(sectionKey)
    const previousTree = previousTrees?.get(sectionKey)
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
      sectionTrees.set(sectionKey, previousTree)
      for (const { key } of occurrences) {
        const previousRange = previousRanges.get(key)
        if (previousRange) {
          result.set(key, previousRange)
        }
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
    sectionTrees.set(sectionKey, tree)
    occurrences.forEach((occurrence, index) => {
      const length = tree.ends[index]! - index - 1
      if (length > 0) {
        result.set(occurrence.key, { tree, index, length })
      }
    })
  }
  rangesByPlan.set(plan, result)
  sectionTreesByPlan.set(plan, sectionTrees)
  previousPlan = plan
  return result
}
