import type { WorktreeDragGroup } from './worktree-manual-order'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/group-keys'
import { getNaturalWorktreeKeys } from '../listing/natural-worktree-keys'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

export type WorktreeDragUnitGroup = WorktreeDragGroup & {
  units: { worktreeId: string; worktreeIds: string[] }[]
}

type WorktreeDragUnitRow =
  | { type: 'host-header' }
  | { type: 'header'; key: string }
  | {
      type: 'item'
      worktree: { id: string; hostId?: ExecutionHostId }
      depth: number
      sectionKey: string
    }
  | { type: 'imported-worktrees-card' }
  | { type: 'new-external-worktrees-inbox' }
  | { type: 'pending-creation' }
  | { type: 'folder-workspace' }

/** Unit members are host identities, matching getWorktreeDragGroups: each row joins its own
 * section's group, and a unit is a row with the deeper rows under it. A folder workspace's children
 * start at depth 1 under a folder row that joins no group, so depth is relative to the unit's root. */
export function getWorktreeDragUnitGroups(
  rows: readonly WorktreeDragUnitRow[]
): WorktreeDragUnitGroup[] {
  const groups: WorktreeDragUnitGroup[] = []
  const unitsByKey = new Map<
    string,
    (WorktreeDragUnitGroup['units'][number] & { depth: number })[]
  >()
  const groupUnits = (key: string) => {
    let units = unitsByKey.get(key)
    if (!units) {
      units = []
      unitsByKey.set(key, units)
      groups.push({ key, units, worktreeIds: [] })
    }
    return units
  }
  const naturalWorktreeKeys = getNaturalWorktreeKeys(rows)

  for (const row of rows) {
    if (row.type === 'header') {
      groupUnits(row.key)
      continue
    }
    if (
      row.type === 'host-header' ||
      row.type === 'imported-worktrees-card' ||
      row.type === 'new-external-worktrees-inbox' ||
      row.type === 'pending-creation' ||
      row.type === 'folder-workspace'
    ) {
      continue
    }
    const worktreeKey = composeWorktreeHostIdentity(row.worktree.hostId, row.worktree.id)
    if (row.sectionKey === PINNED_GROUP_KEY && naturalWorktreeKeys.has(worktreeKey)) {
      continue
    }
    const units = groupUnits(row.sectionKey)
    const last = units.at(-1)
    if (last && row.depth > last.depth) {
      last.worktreeIds.push(worktreeKey)
      continue
    }
    units.push({ worktreeId: worktreeKey, worktreeIds: [worktreeKey], depth: row.depth })
  }

  return groups
    .map((group) => ({
      key: group.key,
      units: group.units.map(({ worktreeId, worktreeIds }) => ({ worktreeId, worktreeIds })),
      worktreeIds: group.units.map((unit) => unit.worktreeId)
    }))
    .filter((group) => group.worktreeIds.length > 0)
}

export function getFullDropIndexForWorktreeDragUnit(args: {
  groups: readonly WorktreeDragUnitGroup[]
  sourceGroupKey: string
  dropIndex: number
}): number {
  const group = args.groups.find((candidate) => candidate.key === args.sourceGroupKey)
  if (!group) {
    return args.dropIndex
  }
  const boundedDropIndex = Math.max(0, Math.min(group.units.length, args.dropIndex))
  let fullDropIndex = 0
  for (let index = 0; index < boundedDropIndex; index++) {
    fullDropIndex += group.units[index]?.worktreeIds.length ?? 0
  }
  return fullDropIndex
}
