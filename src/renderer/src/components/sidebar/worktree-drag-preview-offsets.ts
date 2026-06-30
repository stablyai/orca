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

function getFallbackStride(rects: readonly WorktreeDragPreviewRect[]): number {
  const sortedRects = [...rects].sort((a, b) => a.groupIndex - b.groupIndex)
  const strides: number[] = []
  for (let index = 1; index < sortedRects.length; index++) {
    strides.push(sortedRects[index]!.top - sortedRects[index - 1]!.top)
  }
  if (strides.length > 0) {
    strides.sort((a, b) => a - b)
    return strides[Math.floor(strides.length / 2)]!
  }
  const firstRect = sortedRects[0]
  return firstRect ? firstRect.bottom - firstRect.top : 0
}

function getFallbackGap(rects: readonly WorktreeDragPreviewRect[]): number {
  const sortedRects = [...rects].sort((a, b) => a.groupIndex - b.groupIndex)
  const gaps: number[] = []
  for (let index = 1; index < sortedRects.length; index++) {
    gaps.push(Math.max(0, sortedRects[index]!.top - sortedRects[index - 1]!.bottom))
  }
  if (gaps.length === 0) {
    return 0
  }
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]!
}

export function buildWorktreeDragPreviewOffsets(args: {
  groupIds: readonly string[]
  draggedIds: readonly string[]
  dropIndex: number
  rects: readonly WorktreeDragPreviewRect[]
}): Map<string, number> {
  const nextIds = moveWorktreeIdsWithinGroup(args.groupIds, args.draggedIds, args.dropIndex)
  if (arraysEqual(nextIds, args.groupIds)) {
    return new Map()
  }

  const draggedSet = new Set(args.draggedIds)
  const newIndexById = new Map<string, number>()
  nextIds.forEach((id, index) => newIndexById.set(id, index))

  const groupIdSet = new Set(args.groupIds)
  const rectById = new Map<string, WorktreeDragPreviewRect>()
  for (const rect of args.rects) {
    if (groupIdSet.has(rect.worktreeId)) {
      rectById.set(rect.worktreeId, rect)
    }
  }

  const fallbackStride = getFallbackStride(args.rects)
  const fallbackGap = getFallbackGap(args.rects)
  const groupRects = args.groupIds.flatMap((id) => {
    const rect = rectById.get(id)
    return rect ? [rect] : []
  })
  const baseTop = groupRects[0]?.top ?? 0
  const fallbackHeight = Math.max(0, fallbackStride - fallbackGap)
  const gapAfterById = new Map<string, number>()
  for (let index = 0; index < groupRects.length; index++) {
    const rect = groupRects[index]!
    const nextRect = groupRects[index + 1]
    gapAfterById.set(
      rect.worktreeId,
      nextRect ? Math.max(0, nextRect.top - rect.bottom) : fallbackGap
    )
  }

  const targetTopById = new Map<string, number>()
  let nextTop = baseTop
  // Why: lineage drag units can be much taller than ordinary cards, so replay
  // layout with measured heights instead of mapping indexes to old slot tops.
  for (const id of nextIds) {
    targetTopById.set(id, nextTop)
    const rect = rectById.get(id)
    const height = rect ? rect.bottom - rect.top : fallbackHeight
    nextTop += height + (gapAfterById.get(id) ?? fallbackGap)
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
  return offsets
}
