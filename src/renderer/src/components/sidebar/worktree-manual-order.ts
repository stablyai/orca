import {
  buildSparseManualOrderUpdates,
  type WorktreeManualOrderUpdate
} from './worktree-manual-order-ranks'

export type { WorktreeManualOrderUpdate } from './worktree-manual-order-ranks'

export type WorktreeDragGroup = {
  key: string
  worktreeIds: readonly string[]
}

export type WorktreeDragLineageRow = {
  worktreeId: string
  depth: number
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function appendWorktreeIds(target: string[], ids: readonly string[]): void {
  // Why: generated workspace fleets can exceed V8's argument limit for
  // `push(...ids)` while manual ordering still needs the full visible order.
  for (const id of ids) {
    target.push(id)
  }
}

function insertWorktreeIds(target: string[], index: number, ids: readonly string[]): void {
  const tail = target.splice(index)
  appendWorktreeIds(target, ids)
  appendWorktreeIds(target, tail)
}

export function expandDraggedWorktreeIdsForVisibleLineage(
  rows: readonly WorktreeDragLineageRow[],
  draggedIds: readonly string[]
): string[] {
  const draggedSet = new Set(draggedIds)
  const expandedSet = new Set(draggedIds)
  const rowIdSet = new Set(rows.map((row) => row.worktreeId))

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    if (!draggedSet.has(row.worktreeId)) {
      continue
    }
    for (let cursor = index + 1; cursor < rows.length; cursor++) {
      const child = rows[cursor]!
      if (child.depth <= row.depth) {
        break
      }
      expandedSet.add(child.worktreeId)
    }
  }

  const expandedIds: string[] = []
  for (const row of rows) {
    if (expandedSet.has(row.worktreeId)) {
      expandedIds.push(row.worktreeId)
    }
  }
  for (const id of draggedIds) {
    if (!rowIdSet.has(id) && !expandedIds.includes(id)) {
      expandedIds.push(id)
    }
  }
  return expandedIds
}

export function moveWorktreeIdsWithinGroup(
  groupIds: readonly string[],
  draggedIds: readonly string[],
  dropIndex: number
): string[] {
  if (groupIds.length === 0 || draggedIds.length === 0) {
    return [...groupIds]
  }

  const groupIdSet = new Set(groupIds)
  const draggedSet = new Set<string>()
  const orderedDraggedIds: string[] = []
  for (const id of draggedIds) {
    if (!groupIdSet.has(id) || draggedSet.has(id)) {
      continue
    }
    draggedSet.add(id)
  }
  for (const id of groupIds) {
    if (draggedSet.has(id)) {
      orderedDraggedIds.push(id)
    }
  }
  if (orderedDraggedIds.length === 0) {
    return [...groupIds]
  }

  const boundedDropIndex = Math.max(0, Math.min(groupIds.length, dropIndex))
  let removedBeforeDrop = 0
  for (let i = 0; i < boundedDropIndex; i++) {
    const id = groupIds[i]
    if (id !== undefined && draggedSet.has(id)) {
      removedBeforeDrop++
    }
  }

  const remaining = groupIds.filter((id) => !draggedSet.has(id))
  const insertAt = Math.max(0, Math.min(remaining.length, boundedDropIndex - removedBeforeDrop))
  const next = remaining.slice()
  insertWorktreeIds(next, insertAt, orderedDraggedIds)
  return next
}

export function buildManualOrderUpdatesForVisibleGroups(args: {
  groups: readonly WorktreeDragGroup[]
  sourceGroupKey: string
  draggedIds: readonly string[]
  dropIndex: number
  now: number
  rankByWorktreeId?: ReadonlyMap<string, number>
}): {
  changed: boolean
  orderedIds: string[]
  updates: Map<string, WorktreeManualOrderUpdate>
} {
  const orderedIds: string[] = []
  let changed = false

  for (const group of args.groups) {
    const ids =
      group.key === args.sourceGroupKey
        ? moveWorktreeIdsWithinGroup(group.worktreeIds, args.draggedIds, args.dropIndex)
        : [...group.worktreeIds]
    if (group.key === args.sourceGroupKey && !arraysEqual(ids, group.worktreeIds)) {
      changed = true
    }
    appendWorktreeIds(orderedIds, ids)
  }

  if (!changed) {
    return { changed, orderedIds, updates: new Map() }
  }

  return {
    changed,
    orderedIds,
    updates: buildSparseManualOrderUpdates({
      orderedIds,
      movedIds: args.draggedIds,
      rankByWorktreeId: args.rankByWorktreeId,
      now: args.now
    })
  }
}

export function buildManualOrderUpdatesForGroupDrop(args: {
  groups: readonly WorktreeDragGroup[]
  targetGroupKey: string
  draggedIds: readonly string[]
  dropIndex: number
  now: number
  rankByWorktreeId?: ReadonlyMap<string, number>
}): {
  changed: boolean
  orderedIds: string[]
  updates: Map<string, WorktreeManualOrderUpdate>
} {
  const draggedSet = new Set<string>()
  for (const id of args.draggedIds) {
    draggedSet.add(id)
  }

  const orderedDraggedIds: string[] = []
  for (const group of args.groups) {
    for (const id of group.worktreeIds) {
      if (draggedSet.has(id) && !orderedDraggedIds.includes(id)) {
        orderedDraggedIds.push(id)
      }
    }
  }
  if (orderedDraggedIds.length === 0) {
    return {
      changed: false,
      orderedIds: args.groups.flatMap((group) => group.worktreeIds),
      updates: new Map()
    }
  }

  const orderedIds: string[] = []
  let changed = false
  for (const group of args.groups) {
    let ids: string[]
    if (group.key === args.targetGroupKey) {
      const boundedDropIndex = Math.max(0, Math.min(group.worktreeIds.length, args.dropIndex))
      let removedBeforeDrop = 0
      for (let index = 0; index < boundedDropIndex; index++) {
        const id = group.worktreeIds[index]
        if (id !== undefined && draggedSet.has(id)) {
          removedBeforeDrop++
        }
      }
      ids = group.worktreeIds.filter((id) => !draggedSet.has(id))
      insertWorktreeIds(
        ids,
        Math.max(0, Math.min(ids.length, boundedDropIndex - removedBeforeDrop)),
        orderedDraggedIds
      )
    } else {
      ids = group.worktreeIds.filter((id) => !draggedSet.has(id))
    }

    if (!arraysEqual(ids, group.worktreeIds)) {
      changed = true
    }
    appendWorktreeIds(orderedIds, ids)
  }

  if (!changed) {
    return { changed, orderedIds, updates: new Map() }
  }
  return {
    changed,
    orderedIds,
    updates: buildSparseManualOrderUpdates({
      orderedIds,
      movedIds: orderedDraggedIds,
      rankByWorktreeId: args.rankByWorktreeId,
      now: args.now
    })
  }
}

export function shouldWriteManualOrderForGroupDrop(args: {
  sortBy: string
  sourceGroupKeys: readonly string[]
  targetGroupKey: string
}): boolean {
  if (args.sortBy === 'manual') {
    return true
  }
  return (
    args.sourceGroupKeys.length > 0 &&
    args.sourceGroupKeys.every((sourceGroupKey) => sourceGroupKey === args.targetGroupKey)
  )
}
