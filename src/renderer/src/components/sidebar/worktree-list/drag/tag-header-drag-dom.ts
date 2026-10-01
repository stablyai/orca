import {
  isSidebarHeaderActionTarget,
  readOrderedHeaderRects,
  type OrderedHeaderRect
} from '../../ordered-header-drag-dom'
import { normalizeWorktreeTag } from '../../../../../../shared/worktree/worktree-tags'

export const isTagHeaderActionTarget = isSidebarHeaderActionTarget

/** Tag headers in render order; Untagged carries no drag id, so it never joins the order. */
export function readTagHeaderRects(container: HTMLElement): OrderedHeaderRect[] {
  return readOrderedHeaderRects(
    container,
    '[data-tag-header-drag-id]',
    (header) => normalizeWorktreeTag(header.dataset.tagHeaderDragId) || null
  )
}
