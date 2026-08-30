import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getLineageRenderInfo } from './worktree-lineage-projection'

const WORKTREE_CARD_CONTENT_TARGET_SELECTOR = '[data-worktree-card-parent-content]'
const WORKTREE_DRAG_ROW_SELECTOR = '[data-worktree-drag-id]'

const LINEAGE_REORDER_GUTTER_MAX_PX = 16
const LINEAGE_REORDER_GUTTER_RATIO = 0.2

type VerticalRect = Pick<DOMRect, 'top' | 'bottom'>
type IndexedVerticalRect = VerticalRect & { groupIndex: number }

function getLineageReorderGutterHeight(height: number): number {
  return Math.min(LINEAGE_REORDER_GUTTER_MAX_PX, height * LINEAGE_REORDER_GUTTER_RATIO)
}

export function isWorktreeLineageDropZoneHit(args: {
  pointerY: number
  rect: VerticalRect
}): boolean {
  const height = Math.max(0, args.rect.bottom - args.rect.top)
  if (height <= 0) {
    return false
  }

  const gutter = getLineageReorderGutterHeight(height)
  return args.pointerY >= args.rect.top + gutter && args.pointerY <= args.rect.bottom - gutter
}

export function getWorktreeLineageSiblingDropIndex(args: {
  pointerY: number
  rects: readonly IndexedVerticalRect[]
}): number | null {
  for (const rect of args.rects) {
    const height = Math.max(0, rect.bottom - rect.top)
    if (height <= 0) {
      continue
    }
    const gutter = getLineageReorderGutterHeight(height)
    if (args.pointerY >= rect.top && args.pointerY < rect.top + gutter) {
      return rect.groupIndex
    }
    if (args.pointerY > rect.bottom - gutter && args.pointerY <= rect.bottom) {
      return rect.groupIndex + 1
    }
  }
  return null
}

export function getWorktreeLineageDropTargetId(args: {
  container: HTMLElement
  target: Element
  pointerY: number
}): string | null {
  const contentTarget = args.target.closest<HTMLElement>(WORKTREE_CARD_CONTENT_TARGET_SELECTOR)
  if (!contentTarget || !args.container.contains(contentTarget)) {
    return null
  }

  // Why: nesting should be deliberate; the top/bottom of a card stays available
  // for reorder drops instead of treating the whole card as a parent target.
  if (
    !isWorktreeLineageDropZoneHit({
      pointerY: args.pointerY,
      rect: contentTarget.getBoundingClientRect()
    })
  ) {
    return null
  }

  const rowTarget = contentTarget.closest<HTMLElement>(WORKTREE_DRAG_ROW_SELECTOR)
  if (!rowTarget || !args.container.contains(rowTarget)) {
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
