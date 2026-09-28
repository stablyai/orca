import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getLineageRenderInfo } from './worktree-lineage-projection'

const WORKTREE_CARD_CONTENT_TARGET_SELECTOR = '[data-worktree-card-parent-content]'
const WORKTREE_DRAG_ROW_SELECTOR = '[data-worktree-drag-id]'

const REORDER_GUTTER_RATIO = 0.2
const REORDER_GUTTER_MAX_HEIGHT_PX = 8

type VerticalRect = Pick<DOMRect, 'top' | 'bottom'>

export function isWorktreeLineageDropZoneHit(args: {
  pointerY: number
  rect: VerticalRect
}): boolean {
  const height = Math.max(0, args.rect.bottom - args.rect.top)
  if (height <= 0) {
    return false
  }

  const gutterHeight = Math.min(height * REORDER_GUTTER_RATIO, REORDER_GUTTER_MAX_HEIGHT_PX)
  const zoneTop = args.rect.top + gutterHeight
  const zoneBottom = args.rect.bottom - gutterHeight
  return args.pointerY >= zoneTop && args.pointerY <= zoneBottom
}

export function getWorktreeLineageDropTargetId(args: {
  container: HTMLElement
  target: Element
  pointerY: number
}): string | null {
  const rowTarget = args.target.closest<HTMLElement>(WORKTREE_DRAG_ROW_SELECTOR)
  if (!rowTarget || !args.container.contains(rowTarget)) {
    return null
  }

  const contentTarget = rowTarget.querySelector<HTMLElement>(WORKTREE_CARD_CONTENT_TARGET_SELECTOR)
  if (!contentTarget || contentTarget.closest(WORKTREE_DRAG_ROW_SELECTOR) !== rowTarget) {
    return null
  }

  const rect = contentTarget.getBoundingClientRect()
  // Legacy cards include descendants inside parent content; keep their rows out of its hit zone.
  const firstChildRow = contentTarget.querySelector<HTMLElement>(WORKTREE_DRAG_ROW_SELECTOR)
  const bottom = firstChildRow
    ? Math.min(rect.bottom, firstChildRow.getBoundingClientRect().top)
    : rect.bottom
  if (
    !isWorktreeLineageDropZoneHit({
      pointerY: args.pointerY,
      rect: { top: rect.top, bottom }
    })
  ) {
    return null
  }

  return rowTarget.getAttribute('data-worktree-drag-id')
}

export function getReorderedWorktreeIdsToUnnest(args: {
  draggedIds: readonly string[]
  sourceGroupIds: readonly string[]
  lineageById: Readonly<Record<string, WorktreeLineage>>
  worktreeMap: ReadonlyMap<string, Worktree>
  cyclicLineageIds: ReadonlySet<string>
}): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const sourceGroupIdSet = new Set(args.sourceGroupIds)
  for (const id of args.draggedIds) {
    const worktree = args.worktreeMap.get(id)
    if (
      seen.has(id) ||
      !sourceGroupIdSet.has(id) ||
      !worktree ||
      getLineageRenderInfo(worktree, args.lineageById, args.worktreeMap, args.cyclicLineageIds)
        .state !== 'valid'
    ) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids
}
