import { moveWorktreeIdsWithinGroup } from './worktree-manual-order'

export type WorktreeDragPreviewRect = {
  worktreeId: string
  groupIndex: number
  top: number
  bottom: number
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function getFallbackStride(rects: readonly WorktreeDragPreviewRect[], defaultGap: number): number {
  const sortedRects = [...rects].sort((a, b) => a.groupIndex - b.groupIndex)
  const strides: number[] = []
  for (let index = 1; index < sortedRects.length; index++) {
    const previous = sortedRects[index - 1]!
    const current = sortedRects[index]!
    const indexDelta = current.groupIndex - previous.groupIndex
    if (indexDelta > 0) {
      strides.push((current.top - previous.top) / indexDelta)
    }
  }
  if (strides.length > 0) {
    strides.sort((a, b) => a - b)
    return strides[Math.floor(strides.length / 2)]!
  }
  const firstRect = sortedRects[0]
  return firstRect ? firstRect.bottom - firstRect.top + defaultGap : 0
}

function getFallbackGap(rects: readonly WorktreeDragPreviewRect[], defaultGap: number): number {
  const sortedRects = [...rects].sort((a, b) => a.groupIndex - b.groupIndex)
  const gaps: number[] = []
  for (let index = 1; index < sortedRects.length; index++) {
    const previous = sortedRects[index - 1]!
    const current = sortedRects[index]!
    if (current.groupIndex === previous.groupIndex + 1) {
      gaps.push(Math.max(0, current.top - previous.bottom))
    }
  }
  if (gaps.length === 0) {
    return defaultGap
  }
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]!
}

function getPreviewLayoutDraggedIds(
  groupIds: readonly string[],
  draggedIds: readonly string[],
  draggingWorktreeId?: string | null
): readonly string[] {
  if (draggedIds.length <= 1) {
    return draggedIds
  }
  const draggedSet = new Set(draggedIds)
  if (
    draggingWorktreeId &&
    draggedSet.has(draggingWorktreeId) &&
    groupIds.includes(draggingWorktreeId)
  ) {
    return [draggingWorktreeId]
  }
  const firstVisibleDraggedId = groupIds.find((id) => draggedSet.has(id))
  return firstVisibleDraggedId ? [firstVisibleDraggedId] : draggedIds.slice(0, 1)
}

export type WorktreeDragPreviewLayout = {
  offsets: Map<string, number>
  // Top of the slot the dragged card lands in, in the same coordinate space as
  // `rects`. Null when the drop is a no-op. The drop indicator draws here so the
  // line marks the gap the offsets actually open.
  placeholderTop: number | null
}

export function buildWorktreeDragPreviewOffsets(args: {
  groupIds: readonly string[]
  draggedIds: readonly string[]
  draggingWorktreeId?: string | null
  draggedPreviewHeight?: number | null
  fallbackGap?: number
  dropIndex: number
  rects: readonly WorktreeDragPreviewRect[]
}): WorktreeDragPreviewLayout {
  const committedNextIds = moveWorktreeIdsWithinGroup(
    args.groupIds,
    args.draggedIds,
    args.dropIndex
  )
  if (arraysEqual(committedNextIds, args.groupIds)) {
    return { offsets: new Map(), placeholderTop: null }
  }

  // Why: dragging a large multi-select batch should advertise the insertion
  // point without opening a giant hole that makes the sidebar jump around.
  const layoutDraggedIds = getPreviewLayoutDraggedIds(
    args.groupIds,
    args.draggedIds,
    args.draggingWorktreeId
  )
  const nextIds = moveWorktreeIdsWithinGroup(args.groupIds, layoutDraggedIds, args.dropIndex)
  if (arraysEqual(nextIds, args.groupIds)) {
    return { offsets: new Map(), placeholderTop: null }
  }

  const draggedSet = new Set(layoutDraggedIds)
  const newIndexById = new Map<string, number>()
  nextIds.forEach((id, index) => newIndexById.set(id, index))

  const groupIdSet = new Set(args.groupIds)
  const rectById = new Map<string, WorktreeDragPreviewRect>()
  for (const rect of args.rects) {
    if (groupIdSet.has(rect.worktreeId)) {
      rectById.set(rect.worktreeId, rect)
    }
  }

  const defaultGap =
    typeof args.fallbackGap === 'number' &&
    Number.isFinite(args.fallbackGap) &&
    args.fallbackGap >= 0
      ? args.fallbackGap
      : 0
  const fallbackStride = getFallbackStride(args.rects, defaultGap)
  const fallbackGap = getFallbackGap(args.rects, defaultGap)
  const groupRects = args.groupIds.flatMap((id) => {
    const rect = rectById.get(id)
    return rect ? [rect] : []
  })
  const fallbackHeight = Math.max(0, fallbackStride - fallbackGap)
  const gapAfterById = new Map<string, number>()
  for (let index = 0; index < groupRects.length; index++) {
    const rect = groupRects[index]!
    const nextRect = groupRects[index + 1]
    gapAfterById.set(
      rect.worktreeId,
      nextRect?.groupIndex === rect.groupIndex + 1
        ? Math.max(0, nextRect.top - rect.bottom)
        : fallbackGap
    )
  }

  const previewDraggedId = layoutDraggedIds[0] ?? null
  const draggedPreviewHeight =
    previewDraggedId === args.draggingWorktreeId &&
    typeof args.draggedPreviewHeight === 'number' &&
    Number.isFinite(args.draggedPreviewHeight) &&
    args.draggedPreviewHeight > 0
      ? args.draggedPreviewHeight
      : null
  const getHeight = (id: string): number => {
    const rect = rectById.get(id)
    if (rect) {
      return rect.bottom - rect.top
    }
    return id === previewDraggedId && draggedPreviewHeight !== null
      ? draggedPreviewHeight
      : fallbackHeight
  }
  const getStride = (id: string): number => getHeight(id) + (gapAfterById.get(id) ?? fallbackGap)

  const firstGroupRect = groupRects[0]
  let baseTop = firstGroupRect?.top ?? 0
  if (firstGroupRect) {
    // Why: virtualized leading rows are absent from rects, so derive the full
    // list origin from the first mounted row before replaying its order.
    for (let index = 0; index < firstGroupRect.groupIndex; index++) {
      const id = args.groupIds[index]
      if (id) {
        baseTop -= getStride(id)
      }
    }
  }

  const targetTopById = new Map<string, number>()
  let nextTop = baseTop
  // Why: lineage drag units can be much taller than ordinary cards, so replay
  // layout with measured heights instead of mapping indexes to old slot tops.
  for (const id of nextIds) {
    targetTopById.set(id, nextTop)
    nextTop += getStride(id)
  }

  const offsets = new Map<string, number>()
  for (const rect of args.rects) {
    if (draggedSet.has(rect.worktreeId)) {
      continue
    }
    const newIndex = newIndexById.get(rect.worktreeId)
    if (newIndex === undefined) {
      continue
    }
    const fallbackTop = rect.top + (newIndex - rect.groupIndex) * fallbackStride
    const offset = (targetTopById.get(rect.worktreeId) ?? fallbackTop) - rect.top
    if (Math.abs(offset) >= 0.5) {
      offsets.set(rect.worktreeId, offset)
    }
  }
  return {
    offsets,
    placeholderTop: targetTopById.get(layoutDraggedIds[0] ?? '') ?? null
  }
}
