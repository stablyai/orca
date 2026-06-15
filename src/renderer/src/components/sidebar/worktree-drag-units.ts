import type { WorktreeDragGroup } from './worktree-manual-order'
import { ALL_GROUP_KEY } from './worktree-list-groups'

export type WorktreeDragUnitGroup = WorktreeDragGroup & {
  units: { worktreeId: string; worktreeIds: string[] }[]
}

type WorktreeDragUnitRow =
  | { type: 'host-header' }
  | { type: 'header'; key: string }
  | { type: 'item'; worktree: { id: string }; depth: number }
  | { type: 'imported-worktrees-card' }
  | { type: 'pending-creation' }
  | { type: 'folder-workspace' }

export function getWorktreeDragUnitGroups(
  rows: readonly WorktreeDragUnitRow[]
): WorktreeDragUnitGroup[] {
  const groups: WorktreeDragUnitGroup[] = []
  let current: { key: string; units: WorktreeDragUnitGroup['units'] } | null = null

  for (const row of rows) {
    if (row.type === 'header') {
      current = { key: row.key, units: [] }
      groups.push({
        key: current.key,
        units: current.units,
        worktreeIds: current.units.map((unit) => unit.worktreeId)
      })
      continue
    }
    if (
      row.type === 'host-header' ||
      row.type === 'imported-worktrees-card' ||
      row.type === 'pending-creation' ||
      row.type === 'folder-workspace'
    ) {
      continue
    }
    if (!current) {
      current = { key: ALL_GROUP_KEY, units: [] }
      groups.push({
        key: current.key,
        units: current.units,
        worktreeIds: current.units.map((unit) => unit.worktreeId)
      })
    }
    if (row.depth > 0 && current.units.length > 0) {
      current.units.at(-1)!.worktreeIds.push(row.worktree.id)
      continue
    }
    current.units.push({ worktreeId: row.worktree.id, worktreeIds: [row.worktree.id] })
  }

  return groups
    .map((group) => ({
      ...group,
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
