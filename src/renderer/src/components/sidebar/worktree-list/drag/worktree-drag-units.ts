import type { WorktreeDragGroup } from './worktree-manual-order'
import { isFolderLaneSectionKey } from '../../../../../../shared/sidebar-list/folder-workspace-occurrences'
import { ALL_GROUP_KEY, PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/group-keys'
import { getFolderWorkspaceRowDragGroupKey } from './groups'
import { getNaturalWorktreeKeys } from '../listing/natural-worktree-keys'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getFolderWorkspaceHostIdentity } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'

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
  | {
      type: 'folder-workspace'
      folderWorkspace: Pick<
        FolderWorkspace,
        'id' | 'projectGroupId' | 'executionHostId' | 'connectionId'
      >
    }

/** Unit members are host identities, matching getWorktreeDragGroups. */
export function getWorktreeDragUnitGroups(
  rows: readonly WorktreeDragUnitRow[]
): WorktreeDragUnitGroup[] {
  const groups: WorktreeDragUnitGroup[] = []
  let current: { key: string; units: WorktreeDragUnitGroup['units'] } | null = null
  let currentFolderUnits: WorktreeDragUnitGroup['units'] | null = null
  const folderLanes = new Map<string, { key: string; units: WorktreeDragUnitGroup['units'] }>()
  // A folder workspace row joins no unit of its lane, so the rows nested under it start their own
  // units; within them, a unit is a row plus the deeper rows below it.
  let folderChildUnit: { units: WorktreeDragUnitGroup['units']; depth: number } | null = null
  const naturalWorktreeKeys = getNaturalWorktreeKeys(rows)

  for (const row of rows) {
    if (row.type === 'header') {
      folderChildUnit = null
      current = { key: row.key, units: [] }
      currentFolderUnits = null
      groups.push({
        key: current.key,
        units: current.units,
        worktreeIds: current.units.map((unit) => unit.worktreeId)
      })
      continue
    }
    if (row.type === 'folder-workspace') {
      folderChildUnit = { units: [], depth: Number.POSITIVE_INFINITY }
      const key = getFolderWorkspaceRowDragGroupKey(
        current?.key ?? ALL_GROUP_KEY,
        row.folderWorkspace
      )
      if (!key) {
        continue
      }
      if (!currentFolderUnits) {
        currentFolderUnits = []
        groups.push({ key, units: currentFolderUnits, worktreeIds: [] })
      }
      const worktreeId = getFolderWorkspaceHostIdentity(row.folderWorkspace)
      currentFolderUnits.push({ worktreeId, worktreeIds: [worktreeId] })
      continue
    }
    if (
      row.type === 'host-header' ||
      row.type === 'imported-worktrees-card' ||
      row.type === 'new-external-worktrees-inbox' ||
      row.type === 'pending-creation'
    ) {
      continue
    }
    const worktreeKey = composeWorktreeHostIdentity(row.worktree.hostId, row.worktree.id)
    if (row.sectionKey === PINNED_GROUP_KEY && naturalWorktreeKeys.has(worktreeKey)) {
      continue
    }
    let target = current
    if (isFolderLaneSectionKey(row.sectionKey)) {
      target = folderLanes.get(row.sectionKey) ?? null
      if (!target) {
        target = { key: row.sectionKey, units: [] }
        folderLanes.set(row.sectionKey, target)
        groups.push({ key: target.key, units: target.units, worktreeIds: [] })
      }
    } else if (!current) {
      current = { key: ALL_GROUP_KEY, units: [] }
      groups.push({
        key: current.key,
        units: current.units,
        worktreeIds: current.units.map((unit) => unit.worktreeId)
      })
      target = current
    }
    if (!target) {
      continue
    }
    if (folderChildUnit && row.depth > 0) {
      const last = target.units.at(-1)
      if (last && folderChildUnit.units === target.units && row.depth > folderChildUnit.depth) {
        last.worktreeIds.push(worktreeKey)
        continue
      }
      folderChildUnit = { units: target.units, depth: row.depth }
      target.units.push({ worktreeId: worktreeKey, worktreeIds: [worktreeKey] })
      continue
    }
    folderChildUnit = null
    if (row.depth > 0 && target.units.length > 0) {
      target.units.at(-1)!.worktreeIds.push(worktreeKey)
      continue
    }
    target.units.push({ worktreeId: worktreeKey, worktreeIds: [worktreeKey] })
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
