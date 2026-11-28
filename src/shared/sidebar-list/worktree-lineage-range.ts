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
    let canReusePrevious =
      previous !== undefined &&
      previousRanges !== undefined &&
      previousTree !== undefined &&
      previous.length === occurrences.length &&
      (previousTree.replacedRows?.length ?? 0) < MAX_ROW_REPLACEMENTS
    if (canReusePrevious && previous && previousTree) {
      for (let index = 0; index < occurrences.length; index += 1) {
        const occurrence = occurrences[index]
        const before = previous[index]!
        if (
          before.depth !== occurrence.depth ||
          before.key !== occurrence.key ||
          (before.row !== occurrence.row &&
            previousTree.identities[index] !== getWorktreeHostIdentity(occurrence.row))
        ) {
          canReusePrevious = false
          break
        }
      }
    }
    if (canReusePrevious && previousRanges && previousTree) {
      let replaced: number[] | undefined
      for (let index = 0; index < occurrences.length; index += 1) {
        const occurrence = occurrences[index]
        if (previousTree.worktrees[index] !== occurrence.row) {
          previousTree.worktrees[index] = occurrence.row
          ;(replaced ??= []).push(index)
        }
      }
      if (replaced) {
        ;(previousTree.replacedRows ??= []).push(replaced)
      }
      sectionTrees.set(sectionKey, previousTree)
      for (let index = 0; index < occurrences.length; index += 1) {
        const key = occurrences[index].key
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
    for (let index = 0; index < occurrences.length; index += 1) {
      const occurrence = occurrences[index]
      while (stack.length > 0 && occurrences[stack.at(-1)!]!.depth >= occurrence.depth) {
        tree.ends[stack.pop()!] = index
      }
      tree.identities.push(getWorktreeHostIdentity(occurrence.row))
      tree.worktrees.push(occurrence.row)
      stack.push(index)
    }
    for (let i = 0; i < stack.length; i += 1) {
      tree.ends[stack[i]] = occurrences.length
    }
    sectionTrees.set(sectionKey, tree)
    for (let index = 0; index < occurrences.length; index += 1) {
      const length = tree.ends[index]! - index - 1
      if (length > 0) {
        result.set(occurrences[index].key, { tree, index, length })
      }
    }
  }
  rangesByPlan.set(plan, result)
  sectionTreesByPlan.set(plan, sectionTrees)
  previousPlan = plan
  return result
}
