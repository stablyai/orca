import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getLineageRenderInfo } from '../../../../../../shared/sidebar-list/lineage/worktree-lineage-projection'

const WORKTREE_CARD_CONTENT_TARGET_SELECTOR = '[data-worktree-card-parent-content]'
const WORKTREE_DRAG_ROW_SELECTOR = '[data-worktree-drag-id]'
// Folder workspace rows take drops as parents without joining reorder groups. Not the card surface's
// data-worktree-lineage-drop-target, which marks the outlined card and names no row.
const LINEAGE_DROP_ROW_SELECTOR = `${WORKTREE_DRAG_ROW_SELECTOR}, [data-worktree-lineage-drop-row]`

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

export function getWorktreeLineageDropTargetIdentity(args: {
  container: HTMLElement
  target: Element
  pointerY: number
}): string | null {
  const rowTarget = args.target.closest<HTMLElement>(LINEAGE_DROP_ROW_SELECTOR)
  if (!rowTarget || !args.container.contains(rowTarget)) {
    return null
  }

  const contentTarget = rowTarget.querySelector<HTMLElement>(WORKTREE_CARD_CONTENT_TARGET_SELECTOR)
  if (!contentTarget || contentTarget.closest(LINEAGE_DROP_ROW_SELECTOR) !== rowTarget) {
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

  // Host identity, so a drop names the row's own machine even when a twin shares its id.
  return rowTarget.getAttribute('data-worktree-host-identity')
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

/** Where a reorder dropped: the pointer, and the insertion line it committed to, in client pixels. */
export type WorktreeReorderDropPoint = {
  clientX: number
  clientY: number
  lineClientY: number
  retainedFolderIdentities?: ReadonlySet<string>
}

export function getWorktreeReorderDropPoint(
  pointer: { clientX: number; clientY: number },
  drop: { dropIndicatorY: number },
  container: HTMLElement | null
): WorktreeReorderDropPoint | undefined {
  if (!container) {
    return undefined
  }
  return {
    clientX: pointer.clientX,
    clientY: pointer.clientY,
    // The indicator is in scroll-content pixels.
    lineClientY: container.getBoundingClientRect().top + drop.dropIndicatorY - container.scrollTop
  }
}

/** The full logical folder surface, including unmounted descendants and closing padding. */
export function isReorderInsideFolderBounds(
  point: WorktreeReorderDropPoint | undefined,
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'> | undefined
): boolean {
  return (
    point !== undefined &&
    rect !== undefined &&
    point.clientX >= rect.left &&
    point.clientX <= rect.right &&
    point.clientY >= rect.top &&
    point.clientY <= rect.bottom &&
    point.lineClientY > rect.top &&
    point.lineClientY < rect.bottom
  )
}

type PickedCopy = Pick<Worktree, 'id' | 'hostId'>

/**
 * The rows a reorder unnests. Legacy ids (worktree parents) stay bare, as before. A row nested
 * under a folder workspace is named by its own host and kept when it stayed inside its folder; an
 * id it shares with another picked copy in the source group names that copy by host instead.
 */
export function getReorderUnnestRows(args: {
  legacyIds: readonly string[]
  pickedCopies: readonly PickedCopy[]
  sourceGroupIdentities: readonly string[]
  /** The row's folder workspace parent identity, if its parent is a folder. */
  folderParentOf: (identity: string) => string | undefined
  keepsFolderParent: (folderIdentity: string) => boolean
}): (string | PickedCopy)[] {
  const inGroup = (copy: PickedCopy): boolean =>
    args.sourceGroupIdentities.includes(getWorktreeHostIdentity(copy))
  const folderChildren = args.pickedCopies.flatMap((copy) => {
    const folder = inGroup(copy) ? args.folderParentOf(getWorktreeHostIdentity(copy)) : undefined
    return folder === undefined ? [] : [{ copy, folder }]
  })
  const folderCopies = new Set(folderChildren.map(({ copy }) => copy))
  const folderChildIds = new Set(folderChildren.map(({ copy }) => copy.id))
  const legacy = args.legacyIds.flatMap((id): (string | PickedCopy)[] =>
    folderChildIds.has(id)
      ? args.pickedCopies.filter(
          (copy) => copy.id === id && !folderCopies.has(copy) && inGroup(copy)
        )
      : [id]
  )
  return [
    ...legacy,
    ...folderChildren.flatMap(({ copy, folder }) => (args.keepsFolderParent(folder) ? [] : [copy]))
  ]
}
