import type { Worktree, WorktreeLineage } from '../../../../shared/types'
import { getLineageRenderInfo } from './worktree-lineage-projection'

const WORKTREE_CARD_CONTENT_TARGET_SELECTOR = '[data-worktree-card-hover-trigger]'
const WORKTREE_DRAG_ROW_SELECTOR = '[data-worktree-drag-id]'

const LINEAGE_DROP_ZONE_RATIO = 0.4
const LINEAGE_DROP_ZONE_MAX_HEIGHT_PX = 44

type VerticalRect = Pick<DOMRect, 'top' | 'bottom'>

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
