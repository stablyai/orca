import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { HostScopedWorktreeKey } from '../../../../shared/worktree/host-qualified-identity'
import { getWorktreeIdFromHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineageTree } from '../../../../shared/sidebar-list/worktree-lineage-range'
import {
  createLineageRangeAggregate,
  type LineageRangeAggregate
} from '../../../../shared/sidebar-list/lineage-range-aggregate'
import type { SlotTarget } from './worktree-card-slot-targets'
import {
  toLineageSlotRecord,
  mergeRecord,
  type LineageSlotRecord
} from './worktree-card-slot-summary'
import {
  slotSnapshot,
  changedSlotWorkspaces,
  type SlotSnapshot
} from './worktree-card-slot-invalidation'
import { createStaleSlotSet, type StaleSlotSet } from './worktree-card-slot-stale-set'

export type WorkspaceSlot = {
  targets: SlotTarget[]
  record: LineageSlotRecord
  latestAt: number | null
}
/**
 * Lineage rollups read one parent's preorder descendant range. Slots refresh lazily: a structural
 * change only marks the tree stale, and each read projects just the stale slots inside the range
 * it asks for, so a parent with one child costs one projection even in a thousand-row section.
 */
export function createLineageSlotReader(
  ownSlot: (state: AppState, identity: HostScopedWorktreeKey, fallback?: Worktree) => WorkspaceSlot
) {
  type SlotAggregate = { record: LineageSlotRecord; latestAt: number | null }
  type TreeSlots = {
    snapshot: SlotSnapshot
    own: (WorkspaceSlot | undefined)[]
    aggregate: LineageRangeAggregate<SlotAggregate>
    /** Slots to re-project before reading; reads find them without scanning their range. */
    stale: StaleSlotSet
    indicesById: Map<string, number[]>
    /** How many of the tree's in-place row replacements are already marked stale. */
    replacementsSeen: number
  }
  const treeSlots = new WeakMap<WorktreeLineageTree, TreeSlots>()
  const emptyAggregate = (): SlotAggregate => ({ record: toLineageSlotRecord([]), latestAt: null })
  function combineSlots(left: SlotAggregate, right: SlotAggregate): SlotAggregate {
    const record = { ...left.record }
    mergeRecord(record, right.record)
    return { record, latestAt: Math.max(left.latestAt ?? 0, right.latestAt ?? 0) || null }
  }

  /** Brings the tree's bookkeeping up to the current snapshot without projecting any slot. */
  function syncTree(state: AppState, tree: WorktreeLineageTree): TreeSlots {
    const snapshot = slotSnapshot(state)
    const cached = treeSlots.get(tree)
    const replacements = tree.replacedRows
    if (cached && replacements && cached.replacementsSeen < replacements.length) {
      // A reused tree's fallback rows changed; only those slots may project differently.
      for (let step = cached.replacementsSeen; step < replacements.length; step++) {
        for (const index of replacements[step]!) {
          cached.stale.mark(index)
        }
      }
      cached.replacementsSeen = replacements.length
    }
    if (cached?.snapshot === snapshot) {
      return cached
    }
    if (cached) {
      const changed = changedSlotWorkspaces(cached.snapshot, snapshot)
      if (changed) {
        for (const id of changed) {
          for (const index of cached.indicesById.get(id) ?? []) {
            cached.stale.mark(index)
          }
        }
      } else {
        cached.stale.markAll()
      }
      cached.snapshot = snapshot
      return cached
    }
    const size = tree.identities.length
    const stale = createStaleSlotSet(size)
    stale.markAll()
    const indicesById = new Map<string, number[]>()
    tree.identities.forEach((identity, index) => {
      const id = getWorktreeIdFromHostIdentity(identity)
      const indices = indicesById.get(id) ?? []
      indices.push(index)
      indicesById.set(id, indices)
    })
    const result: TreeSlots = {
      snapshot,
      own: Array.from<WorkspaceSlot | undefined>({ length: size }),
      aggregate: createLineageRangeAggregate(
        Array.from({ length: size }, emptyAggregate),
        emptyAggregate,
        combineSlots
      ),
      stale,
      indicesById,
      replacementsSeen: tree.replacedRows?.length ?? 0
    }
    treeSlots.set(tree, result)
    return result
  }

  /**
   * Re-projects only the stale slots in [start, end), batching each contiguous run into one
   * aggregate update. Finding them costs O(k log N) for k stale slots, independent of range size.
   */
  function refreshRange(
    state: AppState,
    tree: WorktreeLineageTree,
    start: number,
    end: number
  ): TreeSlots {
    const slots = syncTree(state, tree)
    const staleIndices: number[] = []
    slots.stale.forEachStale(start, end, (index) => staleIndices.push(index))
    let runStart = -1
    let run: WorkspaceSlot[] = []
    const flush = (): void => {
      if (run.length > 0) {
        slots.aggregate.updateRun(runStart, run)
        run = []
      }
    }
    for (const index of staleIndices) {
      if (run.length > 0 && index !== runStart + run.length) {
        flush()
      }
      if (run.length === 0) {
        runStart = index
      }
      const own = ownSlot(state, tree.identities[index]!, tree.worktrees[index])
      slots.own[index] = own
      slots.stale.clear(index)
      run.push(own)
    }
    flush()
    return slots
  }

  /** The descendants' own slots, fresh for the current snapshot. */
  function descendantSlots(
    state: AppState,
    tree: WorktreeLineageTree,
    index: number
  ): WorkspaceSlot[] {
    const end = tree.ends[index]!
    if (end <= index + 1) {
      return []
    }
    const slots = refreshRange(state, tree, index + 1, end)
    return Array.from({ length: end - index - 1 }, (_, offset) => slots.own[index + 1 + offset]!)
  }

  /** Range queries and localized updates merge O(log N) records, without reprojecting siblings. */
  function descendantSlot(
    state: AppState,
    tree: WorktreeLineageTree,
    index: number
  ): SlotAggregate {
    const end = tree.ends[index]!
    if (end <= index + 1) {
      return emptyAggregate()
    }
    return refreshRange(state, tree, index + 1, end).aggregate.read(index + 1, end)
  }

  return { descendantSlots, descendantSlot }
}
