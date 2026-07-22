import {
  buildSparseManualOrderUpdates,
  type WorktreeManualOrderUpdate
} from './worktree-manual-order-ranks'

const WORKTREE_CARD_CONTENT_TARGET_SELECTOR = '[data-worktree-card-hover-trigger]'
const WORKTREE_DRAG_ROW_SELECTOR = '[data-worktree-drag-id]'
const WORKTREE_LINEAGE_CHILDREN_SELECTOR = '[data-worktree-lineage-children]'
const WORKTREE_LINEAGE_PARENT_ATTRIBUTE = 'data-worktree-lineage-parent-id'

const LINEAGE_DROP_ZONE_RATIO = 0.4
const LINEAGE_DROP_ZONE_MAX_HEIGHT_PX = 44

type VerticalRect = Pick<DOMRect, 'top' | 'bottom'>

export type WorktreeLineageDropTarget = {
  parentId: string
  dropIndicatorY: number
  insertionBeforeChildId?: string | null
}

export function buildWorktreeLineageInsertionOrderUpdates(args: {
  directChildIds: readonly string[]
  draggedIds: readonly string[]
  insertionBeforeChildId: string | null
  orderIndexById: ReadonlyMap<string, number>
  rankByWorktreeId: ReadonlyMap<string, number>
  now: number
}): Map<string, WorktreeManualOrderUpdate> {
  const draggedIdSet = new Set(args.draggedIds)
  const orderedDraggedIds = Array.from(draggedIdSet).sort(
    (left, right) =>
      (args.orderIndexById.get(left) ?? Number.POSITIVE_INFINITY) -
      (args.orderIndexById.get(right) ?? Number.POSITIVE_INFINITY)
  )
  if (orderedDraggedIds.length === 0) {
    return new Map()
  }

  const dropIndex =
    args.insertionBeforeChildId === null
      ? args.directChildIds.length
      : args.directChildIds.indexOf(args.insertionBeforeChildId)
  if (dropIndex < 0) {
    return new Map()
  }
  let removedBeforeDrop = 0
  for (let index = 0; index < dropIndex; index++) {
    if (draggedIdSet.has(args.directChildIds[index]!)) {
      removedBeforeDrop++
    }
  }
  const remainingIds = args.directChildIds.filter((id) => !draggedIdSet.has(id))
  const insertAt = Math.max(0, Math.min(remainingIds.length, dropIndex - removedBeforeDrop))
  const orderedIds = [
    ...remainingIds.slice(0, insertAt),
    ...orderedDraggedIds,
    ...remainingIds.slice(insertAt)
  ]
  if (
    orderedIds.length === args.directChildIds.length &&
    orderedIds.every((id, index) => id === args.directChildIds[index])
  ) {
    return new Map()
  }
  return buildSparseManualOrderUpdates({
    orderedIds,
    movedIds: orderedDraggedIds,
    rankByWorktreeId: args.rankByWorktreeId,
    now: args.now
  })
}

export function getWorktreeLineageInsertionBeforeChildId(args: {
  directChildIds: readonly string[]
  draggedIds: readonly string[]
  orderIndexById: ReadonlyMap<string, number>
}): string | null {
  const draggedIdSet = new Set(args.draggedIds)
  const draggedOrderIndex = args.draggedIds.reduce(
    (index, id) => Math.min(index, args.orderIndexById.get(id) ?? Number.POSITIVE_INFINITY),
    Number.POSITIVE_INFINITY
  )
  if (!Number.isFinite(draggedOrderIndex)) {
    return null
  }
  return (
    args.directChildIds.find(
      (id) =>
        !draggedIdSet.has(id) &&
        (args.orderIndexById.get(id) ?? Number.POSITIVE_INFINITY) > draggedOrderIndex
    ) ?? null
  )
}

export function getWorktreeLineageInsertionGuideY(args: {
  container: HTMLElement
  parentId: string
  directChildIds: readonly string[]
  draggedIds: readonly string[]
  orderIndexById: ReadonlyMap<string, number>
  fallbackY: number
}): number {
  const rows = Array.from(args.container.querySelectorAll<HTMLElement>(WORKTREE_DRAG_ROW_SELECTOR))
  const rowById = (id: string): HTMLElement | undefined =>
    rows.find((row) => row.getAttribute('data-worktree-drag-id') === id)
  const insertBeforeChildId = getWorktreeLineageInsertionBeforeChildId(args)
  const insertBeforeRow = insertBeforeChildId ? rowById(insertBeforeChildId) : undefined
  const parentChildren = rowById(args.parentId)?.querySelector<HTMLElement>(
    WORKTREE_LINEAGE_CHILDREN_SELECTOR
  )
  const indicatorViewportY = insertBeforeRow
    ? insertBeforeRow.getBoundingClientRect().top - 3
    : parentChildren
      ? parentChildren.getBoundingClientRect().bottom + 3
      : null
  if (indicatorViewportY === null) {
    return args.fallbackY
  }
  const containerRect = args.container.getBoundingClientRect()
  return Math.max(0, indicatorViewportY - containerRect.top + args.container.scrollTop)
}

export function isWorktreeLineageDropZoneHit(args: {
  pointerY: number
  rect: VerticalRect
}): boolean {
  const height = Math.max(0, args.rect.bottom - args.rect.top)
  if (height <= 0) {
    return false
  }

  const zoneHeight = Math.min(height * LINEAGE_DROP_ZONE_RATIO, LINEAGE_DROP_ZONE_MAX_HEIGHT_PX)
  const zoneTop = args.rect.top + (height - zoneHeight) / 2
  const zoneBottom = args.rect.bottom - (height - zoneHeight) / 2
  return args.pointerY >= zoneTop && args.pointerY <= zoneBottom
}

export function getWorktreeLineageDropTarget(args: {
  container: HTMLElement
  target: Element
  pointerY: number
}): WorktreeLineageDropTarget | null {
  const contentTarget = args.target.closest<HTMLElement>(WORKTREE_CARD_CONTENT_TARGET_SELECTOR)
  if (!contentTarget || !args.container.contains(contentTarget)) {
    return null
  }

  const contentRect = contentTarget.getBoundingClientRect()
  const lineageChildren = contentTarget.querySelector<HTMLElement>(
    WORKTREE_LINEAGE_CHILDREN_SELECTOR
  )
  // Why: legacy expanded parent cards include descendants inside their hover
  // trigger, but only the parent's own surface should be a nesting target.
  const dropZoneRect = lineageChildren
    ? {
        top: contentRect.top,
        bottom: Math.min(contentRect.bottom, lineageChildren.getBoundingClientRect().top)
      }
    : contentRect
  if (args.pointerY < dropZoneRect.top || args.pointerY > dropZoneRect.bottom) {
    return null
  }

  const rowTarget = contentTarget.closest<HTMLElement>(WORKTREE_DRAG_ROW_SELECTOR)
  if (!rowTarget || !args.container.contains(rowTarget)) {
    return null
  }
  const parentId = rowTarget.getAttribute('data-worktree-drag-id')
  if (!parentId) {
    return null
  }
  const containerRect = args.container.getBoundingClientRect()
  if (
    !isWorktreeLineageDropZoneHit({
      pointerY: args.pointerY,
      rect: dropZoneRect
    })
  ) {
    const lineageParentId = rowTarget.getAttribute(WORKTREE_LINEAGE_PARENT_ATTRIBUTE)
    if (!lineageParentId) {
      return null
    }
    // Why: child-row edges are sibling insertion slots; their center remains
    // available for deliberately creating a deeper parent-child relationship.
    const sectionKey = rowTarget.getAttribute('data-worktree-section-key')
    const directSiblingRows = Array.from(
      args.container.querySelectorAll<HTMLElement>(WORKTREE_DRAG_ROW_SELECTOR)
    ).filter(
      (row) =>
        row.getAttribute(WORKTREE_LINEAGE_PARENT_ATTRIBUTE) === lineageParentId &&
        (!sectionKey || row.getAttribute('data-worktree-section-key') === sectionKey)
    )
    const siblingIndex = directSiblingRows.indexOf(rowTarget)
    if (siblingIndex < 0) {
      return null
    }
    const insertBeforeCurrent = args.pointerY < (dropZoneRect.top + dropZoneRect.bottom) / 2
    const nextSibling = insertBeforeCurrent ? rowTarget : directSiblingRows[siblingIndex + 1]
    const indicatorViewportY = nextSibling
      ? nextSibling.getBoundingClientRect().top - 3
      : rowTarget.getBoundingClientRect().bottom + 3
    return {
      parentId: lineageParentId,
      insertionBeforeChildId: nextSibling?.getAttribute('data-worktree-drag-id') ?? null,
      dropIndicatorY: Math.max(0, indicatorViewportY - containerRect.top + args.container.scrollTop)
    }
  }

  const indicatorViewportY = lineageChildren
    ? lineageChildren.getBoundingClientRect().top - 3
    : dropZoneRect.bottom + 3
  return {
    parentId,
    // Why: the regular reorder guide is positioned in scroll-content space;
    // lineage targets must use the same coordinates to stay aligned on scroll.
    dropIndicatorY: Math.max(0, indicatorViewportY - containerRect.top + args.container.scrollTop)
  }
}

export function getWorktreeLineageDropTargetId(args: {
  container: HTMLElement
  target: Element
  pointerY: number
}): string | null {
  return getWorktreeLineageDropTarget(args)?.parentId ?? null
}

export function getReorderedWorktreeIdsToUnnest(args: {
  draggedIds: readonly string[]
  sourceGroupIds: readonly string[]
  lineageById: Readonly<Record<string, unknown>>
}): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const sourceGroupIdSet = new Set(args.sourceGroupIds)
  for (const id of args.draggedIds) {
    if (seen.has(id) || !sourceGroupIdSet.has(id) || !args.lineageById[id]) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids
}
