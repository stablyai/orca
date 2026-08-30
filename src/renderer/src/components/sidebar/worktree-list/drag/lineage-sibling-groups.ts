import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { HostSectionRow } from '../../host-section-rows'
import { PINNED_GROUP_KEY } from '../grouping/group-keys'

export type WorktreeLineageSiblingRow = {
  rowKey: string
  worktreeId: string
  executionHostId?: ExecutionHostId
}

export type WorktreeLineageSiblingGroup = {
  key: string
  rows: readonly WorktreeLineageSiblingRow[]
}

export type WorktreeLineageSiblingGroupIndex = {
  groups: readonly WorktreeLineageSiblingGroup[]
  groupKeyByRowKey: ReadonlyMap<string, string>
}

export type WorktreeLineageSiblingSelection = WorktreeLineageSiblingGroup & {
  worktreeIds: readonly string[]
  executionHostIdByWorktreeId: ReadonlyMap<string, ExecutionHostId>
  draggedIds: readonly string[]
}

type MutableSiblingGroup = {
  key: string
  rows: WorktreeLineageSiblingRow[]
}

export function buildWorktreeLineageSiblingGroupIndex(
  rows: readonly HostSectionRow[],
  naturalWorktreeIds: ReadonlySet<string>
): WorktreeLineageSiblingGroupIndex {
  const groupsByKey = new Map<string, MutableSiblingGroup>()
  const lineageStack: Extract<HostSectionRow, { type: 'item' }>[] = []

  for (const row of rows) {
    if (row.type !== 'item') {
      lineageStack.length = 0
      continue
    }
    if (row.sectionKey === PINNED_GROUP_KEY && naturalWorktreeIds.has(row.worktree.id)) {
      lineageStack.length = 0
      continue
    }

    lineageStack.length = Math.min(lineageStack.length, row.depth)
    const parent = row.depth > 0 ? lineageStack[row.depth - 1] : undefined
    lineageStack[row.depth] = row
    lineageStack.length = row.depth + 1
    if (!parent) {
      continue
    }

    const key = `lineage-siblings:${parent.rowKey}`
    const group = groupsByKey.get(key) ?? { key, rows: [] }
    group.rows.push({
      rowKey: row.rowKey,
      worktreeId: row.worktree.id,
      executionHostId: row.worktree.hostId
    })
    groupsByKey.set(key, group)
  }

  const groups = [...groupsByKey.values()].filter((group) => group.rows.length > 1)
  const groupKeyByRowKey = new Map<string, string>()
  for (const group of groups) {
    for (const siblingRow of group.rows) {
      groupKeyByRowKey.set(siblingRow.rowKey, group.key)
    }
  }
  return { groups, groupKeyByRowKey }
}

export function resolveWorktreeLineageSiblingSelection(
  index: WorktreeLineageSiblingGroupIndex,
  rowKey: string,
  draggedIds: readonly string[]
): WorktreeLineageSiblingSelection | null {
  const groupKey = index.groupKeyByRowKey.get(rowKey)
  const group = index.groups.find((candidate) => candidate.key === groupKey)
  if (!group || new Set(draggedIds).size !== draggedIds.length) {
    return null
  }

  const worktreeIds = group.rows.map((row) => row.worktreeId)
  const groupIds = new Set(worktreeIds)
  if (draggedIds.some((id) => !groupIds.has(id))) {
    return null
  }
  const draggedIdSet = new Set(draggedIds)
  const orderedDraggedIds = worktreeIds.filter((id) => draggedIdSet.has(id))
  const executionHostIdByWorktreeId = new Map<string, ExecutionHostId>()
  for (const row of group.rows) {
    if (row.executionHostId) {
      executionHostIdByWorktreeId.set(row.worktreeId, row.executionHostId)
    }
  }
  return orderedDraggedIds.length > 0
    ? {
        ...group,
        worktreeIds,
        draggedIds: orderedDraggedIds,
        executionHostIdByWorktreeId
      }
    : null
}
