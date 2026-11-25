import type { CSSProperties } from 'react'
import { SIDEBAR_PROJECTS_MIN_LIST_HEIGHT } from '../../../../../../shared/sidebar-bots-height'

export const WORKTREE_SIDEBAR_SCROLL_STYLE: CSSProperties = {
  // TanStack Virtual owns scroll correction; browser anchoring fights it.
  overflowAnchor: 'none'
}

export function worktreeViewportContainerLayout(
  contentSized: boolean | undefined,
  virtualizer: { getTotalSize(): number }
) {
  const contentHeight = virtualizer.getTotalSize()
  return {
    className: !contentSized ? 'relative min-h-0 flex-1' : 'relative min-h-0 flex-initial',
    // Include the scroller's pt-px above its virtual content.
    style: !contentSized
      ? undefined
      : {
          height: Math.ceil(contentHeight) + 1,
          minHeight: Math.min(Math.ceil(contentHeight) + 1, SIDEBAR_PROJECTS_MIN_LIST_HEIGHT)
        }
  }
}
