import { useCallback, useMemo } from 'react'
import type React from 'react'
import type { RenderRow } from '../listing/render-row'
import type { LineageRowProjection } from '../listing/lineage-row-projection'
import type { WorktreeListVirtualizer } from './use-virtualizer'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getWorktreeDragUnitGroups, type WorktreeDragUnitGroup } from '../drag/worktree-drag-units'
import { getWorktreeDragIndexes } from '../drag/groups'
import type { WorktreeSidebarDragRect } from '../drag/worktree-sidebar-drag-autoscroll'
import {
  isReorderInsideFolderBounds,
  type WorktreeReorderDropPoint
} from '../drag/worktree-lineage-drag-drop'

type DragUnitRowRange = {
  group: string
  identity: string
  groupIndex: number
  first: number
  last: number
  trailing: number
  next: number | undefined
}

type DragUnitRowRanges = {
  byRow: Map<number, DragUnitRowRange>
  byGroup: Map<string, Map<string, DragUnitRowRange>>
}

const dragUnitGroupsCache = new WeakMap<readonly RenderRow[], WorktreeDragUnitGroup[]>()
const dragRangesCache = new WeakMap<
  readonly RenderRow[],
  WeakMap<LineageRowProjection, DragUnitRowRanges>
>()

function getCachedWorktreeDragUnitGroups(rows: readonly RenderRow[]): WorktreeDragUnitGroup[] {
  let cached = dragUnitGroupsCache.get(rows)
  if (!cached) {
    cached = getWorktreeDragUnitGroups(rows)
    dragUnitGroupsCache.set(rows, cached)
  }
  return cached
}

function computeDragRanges(
  rows: readonly RenderRow[],
  projection: LineageRowProjection,
  indexes: ReturnType<typeof getWorktreeDragIndexes>,
  units: readonly WorktreeDragUnitGroup[]
): DragUnitRowRanges {
  const rowByGroupIdentity = new Map<string, Map<string, number>>()
  rows.forEach((row, index) => {
    if (row.type !== 'item') {
      return
    }
    const group = indexes.groupKeyByRowKey.get(row.rowKey)
    if (!group) {
      return
    }
    let members = rowByGroupIdentity.get(group)
    if (!members) {
      rowByGroupIdentity.set(group, (members = new Map()))
    }
    members.set(getWorktreeHostIdentity(row.worktree), index)
  })
  const byRow = new Map<number, DragUnitRowRange>()
  const byGroup = new Map<string, Map<string, DragUnitRowRange>>()
  for (const group of units) {
    const members = rowByGroupIdentity.get(group.key)
    const ranges = new Map<string, DragUnitRowRange>()
    group.units.forEach((unit, groupIndex) => {
      const first = members?.get(unit.worktreeId)
      const last = members?.get(unit.worktreeIds.at(-1)!)
      if (first === undefined || last === undefined) {
        return
      }
      let trailing = 0
      let parent = projection.frames[first].parent
      while (parent !== null) {
        if (projection.frames[parent].end === last) {
          trailing += 7
        }
        parent = projection.frames[parent].parent
      }
      const range: DragUnitRowRange = {
        group: group.key,
        identity: unit.worktreeId,
        groupIndex,
        first,
        last,
        trailing,
        next: members?.get(group.units[groupIndex + 1]?.worktreeId ?? '')
      }
      ranges.set(unit.worktreeId, range)
      for (const identity of unit.worktreeIds) {
        const index = members?.get(identity)
        if (index !== undefined) {
          byRow.set(index, range)
        }
      }
    })
    byGroup.set(group.key, ranges)
  }
  return { byRow, byGroup }
}

function getCachedDragRanges(
  rows: readonly RenderRow[],
  projection: LineageRowProjection,
  indexes: ReturnType<typeof getWorktreeDragIndexes>
): DragUnitRowRanges {
  let byProjection = dragRangesCache.get(rows)
  if (!byProjection) {
    byProjection = new WeakMap()
    dragRangesCache.set(rows, byProjection)
  }
  let cached = byProjection.get(projection)
  if (!cached) {
    cached = computeDragRanges(rows, projection, indexes, getCachedWorktreeDragUnitGroups(rows))
    byProjection.set(projection, cached)
  }
  return cached
}

export type WorktreeRowGeometry = ReturnType<typeof useWorktreeRowGeometry>

export function useWorktreeRowGeometry(args: {
  rows: RenderRow[]
  projection: LineageRowProjection
  virtualization: WorktreeListVirtualizer
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const { rows, projection, virtualization, scrollRef } = args
  const indexes = useMemo(() => getWorktreeDragIndexes(rows), [rows])
  const getUnits = useCallback(() => getCachedWorktreeDragUnitGroups(rows), [rows])
  const getRanges = useCallback(
    () => getCachedDragRanges(rows, projection, indexes),
    [indexes, projection, rows]
  )
  const getRects = useCallback(
    (group: string, retained: readonly string[] = []): WorktreeSidebarDragRect[] => {
      const ranges = getCachedDragRanges(rows, projection, indexes)
      const selected = new Map<string, DragUnitRowRange>()
      for (const item of virtualization.virtualizer.getVirtualItems()) {
        const range = ranges.byRow.get(item.index)
        if (range?.group === group) {
          selected.set(range.identity, range)
        }
      }
      for (const identity of retained) {
        const range = ranges.byGroup.get(group)?.get(identity)
        if (range) {
          selected.set(identity, range)
        }
      }
      const measurements = virtualization.virtualizer.measurementsCache
      return [...selected.values()]
        .flatMap((range) => {
          const first = measurements[range.first]
          const last = measurements[range.last]
          if (!first || !last) {
            return []
          }
          const frame = projection.frames[range.last]
          const bottom = last.end - frame.after - range.trailing
          const next = range.next === undefined ? undefined : measurements[range.next]
          const gap =
            next && range.next !== undefined
              ? Math.max(0, next.start + projection.frames[range.next].before - bottom)
              : projection.frames[range.first].parent === null
                ? 6
                : 4
          return [
            {
              worktreeId: range.identity,
              groupIndex: range.groupIndex,
              top: first.start + projection.frames[range.first].before,
              bottom,
              layoutBottom: bottom + gap
            }
          ]
        })
        .sort((a, b) => a.top - b.top)
    },
    [indexes, projection, rows, virtualization.virtualizer]
  )
  const keepsFolderParent = useCallback(
    (identity: string, point: WorktreeReorderDropPoint | undefined, contentRect?: DOMRect) => {
      if (point?.retainedFolderIdentities) {
        return point.retainedFolderIdentities.has(identity)
      }
      const rect =
        contentRect ??
        scrollRef.current?.querySelector('[data-worktree-sidebar-content]')?.getBoundingClientRect()
      if (!point || !rect) {
        return false
      }
      const measurements = virtualization.virtualizer.measurementsCache
      return (projection.occurrencesByIdentity.get(identity) ?? []).some((index) => {
        if (rows[index]?.type !== 'folder-workspace') {
          return false
        }
        const frame = projection.frames[index]
        const first = measurements[index]
        const last = measurements[frame.end]
        if (!first || !last) {
          return false
        }
        const top = rect.top + first.start + frame.before
        let trailing = 0
        let parent = frame.parent
        while (parent !== null) {
          const ancestor = projection.frames[parent]
          if (ancestor.end === frame.end) {
            trailing += 7
          }
          parent = ancestor.parent
        }
        const bottom = rect.top + last.end - projection.frames[frame.end].after - trailing
        return isReorderInsideFolderBounds(point, {
          left: rect.left + frame.left + 4,
          right: rect.right - frame.right,
          top,
          bottom
        })
      })
    },
    [projection, rows, scrollRef, virtualization.virtualizer]
  )
  const captureFolderRetention = useCallback(
    (point: WorktreeReorderDropPoint | undefined, folderIdentities: ReadonlySet<string>) => {
      if (!point) {
        return point
      }
      const retainedFolderIdentities = new Set<string>()
      if (folderIdentities.size > 0) {
        const rect = scrollRef.current
          ?.querySelector('[data-worktree-sidebar-content]')
          ?.getBoundingClientRect()
        if (rect) {
          for (const identity of folderIdentities) {
            if (keepsFolderParent(identity, point, rect)) {
              retainedFolderIdentities.add(identity)
            }
          }
        }
      }
      return { ...point, retainedFolderIdentities }
    },
    [keepsFolderParent, scrollRef]
  )
  return { getUnits, getRanges, indexes, getRects, keepsFolderParent, captureFolderRetention }
}
