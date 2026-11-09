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

export type WorkspaceSlot = {
  targets: SlotTarget[]
  record: LineageSlotRecord
  latestAt: number | null
}
export function createLineageSlotReader(
  ownSlot: (state: AppState, identity: HostScopedWorktreeKey, fallback?: Worktree) => WorkspaceSlot
) {
  type SlotAggregate = { record: LineageSlotRecord; latestAt: number | null }
  type TreeSlots = {
    snapshot: SlotSnapshot
    own: WorkspaceSlot[]
    aggregate: LineageRangeAggregate<SlotAggregate>
    indicesById: Map<string, number[]>
  }
  const treeSlots = new WeakMap<WorktreeLineageTree, TreeSlots>()
  const emptyAggregate = (): SlotAggregate => ({ record: toLineageSlotRecord([]), latestAt: null })
  function combineSlots(left: SlotAggregate, right: SlotAggregate): SlotAggregate {
    const record = { ...left.record }
    mergeRecord(record, right.record)
    return { record, latestAt: Math.max(left.latestAt ?? 0, right.latestAt ?? 0) || null }
  }
  function updateTreeSlot(slots: TreeSlots, index: number, own: WorkspaceSlot): void {
    slots.own[index] = own
    slots.aggregate.update(index, own)
  }
  function slotsForTree(state: AppState, tree: WorktreeLineageTree): TreeSlots {
    const snapshot = slotSnapshot(state)
    const cached = treeSlots.get(tree)
    if (cached?.snapshot === snapshot) {
      return cached
    }
    const changed = cached && changedSlotWorkspaces(state, cached.snapshot, snapshot)
    if (cached && changed) {
      for (const id of changed) {
        for (const index of cached.indicesById.get(id) ?? []) {
          updateTreeSlot(
            cached,
            index,
            ownSlot(state, tree.identities[index]!, tree.worktrees[index])
          )
        }
      }
      cached.snapshot = snapshot
      return cached
    }
    const own = tree.identities.map((identity, index) =>
      ownSlot(state, identity, tree.worktrees[index])
    )
    const aggregate = createLineageRangeAggregate(own, emptyAggregate, combineSlots)
    const indicesById = new Map<string, number[]>()
    tree.identities.forEach((identity, index) => {
      const id = getWorktreeIdFromHostIdentity(identity)
      const indices = indicesById.get(id) ?? []
      indices.push(index)
      indicesById.set(id, indices)
    })
    const result = { snapshot, own, aggregate, indicesById }
    treeSlots.set(tree, result)
    return result
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
    return slotsForTree(state, tree).aggregate.read(index + 1, end)
  }

  return { slotsForTree, descendantSlot }
}
