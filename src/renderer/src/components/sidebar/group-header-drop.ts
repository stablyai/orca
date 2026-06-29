// group-header-drop.ts
import { interpolateSparseOrder } from './sidebar-drop-order-interpolation'
import { mapSidebarProjectHeaderDropIndexToSiblingInsertIndex } from './project-header-drop'
import { getWorktreeSidebarBoundaryDrop } from './worktree-sidebar-drag-autoscroll'
import type { Row } from './worktree-list-groups'
import type { ProjectGroup } from '../../../../shared/types'

export type GroupHeaderDragRect = {
  groupId: string
  // Index among sibling group headers (same parent) from the row model, not the
  // mounted subset — virtualized rows unmount off-screen headers.
  siblingIndex: number
  top: number
  bottom: number
}

export type GroupHeaderDropPreview = {
  dropIndex: number
  dropIndicatorY: number
}

const INDICATOR_GAP_PX = 4

export { mapSidebarProjectHeaderDropIndexToSiblingInsertIndex as mapSidebarGroupDropIndexToSiblingInsertIndex }

export function getTabOrderForGroupDrop(args: {
  siblings: readonly ProjectGroup[]
  dropIndex: number
}): number {
  if (args.siblings.length === 0) {
    return 0
  }
  const before = args.siblings[args.dropIndex - 1]?.tabOrder
  const after = args.siblings[args.dropIndex]?.tabOrder
  return interpolateSparseOrder(before, after)
}

/** Ordered sibling group ids keyed by parent (null = top level). Mirrors the
 *  row builder's per-parent tabOrder||name sort so drag indices line up. */
export function getSiblingGroupIdsByParent(rows: readonly Row[]): Map<string | null, string[]> {
  const byParent = new Map<string | null, string[]>()
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.type !== 'header' || !row.projectGroup || row.projectGroup.id === null) {
      continue
    }
    if (seen.has(row.projectGroup.id)) {
      continue
    }
    seen.add(row.projectGroup.id)
    const parent =
      'parentGroupId' in row.projectGroup ? (row.projectGroup.parentGroupId ?? null) : null
    const list = byParent.get(parent) ?? []
    list.push(row.projectGroup.id)
    byParent.set(parent, list)
  }
  return byParent
}

function getVirtualRowStart(virtualRow: HTMLElement | null): number | null {
  if (!virtualRow) {
    return null
  }
  const rawStart = virtualRow.getAttribute('data-worktree-virtual-row-start')
  if (rawStart === null) {
    return null
  }
  const start = Number(rawStart)
  return Number.isFinite(start) ? start : null
}

export function measureGroupHeaderDragRects(
  container: HTMLElement,
  parentGroupId?: string | null
): GroupHeaderDragRect[] {
  const containerRect = container.getBoundingClientRect()
  const rects: GroupHeaderDragRect[] = []
  container.querySelectorAll<HTMLElement>('[data-project-group-header-id]').forEach((element) => {
    const groupId = element.getAttribute('data-project-group-header-id')
    const rawSiblingIndex = element.getAttribute('data-project-group-sibling-index')
    const siblingIndex = rawSiblingIndex === null ? Number.NaN : Number(rawSiblingIndex)
    const rawParent = element.getAttribute('data-project-group-parent')
    const elementParent = rawParent === null || rawParent === '' ? null : rawParent
    if (!groupId || !Number.isFinite(siblingIndex)) {
      return
    }
    if (parentGroupId !== undefined && elementParent !== parentGroupId) {
      return
    }
    const rect = element.getBoundingClientRect()
    const virtualRow = element.closest<HTMLElement>('[data-worktree-virtual-row]')
    const virtualRowStart = getVirtualRowStart(virtualRow)
    const top =
      virtualRow && virtualRowStart !== null
        ? virtualRowStart + rect.top - virtualRow.getBoundingClientRect().top
        : rect.top - containerRect.top + container.scrollTop
    rects.push({ groupId, siblingIndex, top, bottom: top + rect.height })
  })
  rects.sort((left, right) => left.top - right.top)
  return rects
}

export function computeGroupHeaderDropPreview(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  rects: readonly GroupHeaderDragRect[]
  siblingGroupIds: readonly string[]
}): GroupHeaderDropPreview | null {
  const { rects, siblingGroupIds } = args
  if (rects.length === 0 || siblingGroupIds.length === 0) {
    return null
  }
  const localY = args.pointerY - args.containerTop + args.scrollTop
  const first = rects[0]!
  const last = rects.at(-1)!
  const boundaryDrop = getWorktreeSidebarBoundaryDrop({
    localY,
    firstRect: {
      worktreeId: first.groupId,
      groupIndex: first.siblingIndex,
      top: first.top,
      bottom: first.bottom
    },
    lastRect: {
      worktreeId: last.groupId,
      groupIndex: last.siblingIndex,
      top: last.top,
      bottom: last.bottom
    },
    sourceGroupSize: siblingGroupIds.length
  })
  if (boundaryDrop.kind === 'outside') {
    return null
  }

  let dropIndex = last.siblingIndex + 1
  let indicatorY = last.bottom + INDICATOR_GAP_PX
  if (boundaryDrop.kind === 'drop') {
    dropIndex = boundaryDrop.dropIndex
    indicatorY = boundaryDrop.indicatorY
  } else {
    for (const rect of rects) {
      const mid = (rect.top + rect.bottom) / 2
      if (localY < mid) {
        dropIndex = rect.siblingIndex
        indicatorY = Math.max(0, rect.top - INDICATOR_GAP_PX)
        break
      }
    }
  }
  return { dropIndex, dropIndicatorY: Math.max(args.scrollTop, indicatorY) }
}
