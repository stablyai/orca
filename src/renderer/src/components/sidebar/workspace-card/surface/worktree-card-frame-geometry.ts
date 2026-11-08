import type React from 'react'
import {
  getFlushWorktreeCardPaddingLeft,
  getNewCardStyleParentContentMarginLeft
} from '../../worktree-list/rows/indentation'

/** Card inset for nesting depth; a leading new-style status lane pulls the content back further. */
export function getWorktreeCardFrameGeometry({
  flushSurface,
  contentIndent,
  statusLane,
  minContentInset
}: {
  flushSurface: boolean
  contentIndent: number
  statusLane: boolean
  minContentInset?: number
}): { cardStyle: React.CSSProperties | undefined; parentContentMarginLeft: number } {
  const cardPaddingLeft = flushSurface
    ? getFlushWorktreeCardPaddingLeft(contentIndent, statusLane, minContentInset)
    : contentIndent > 0
      ? `calc(0.125rem + ${contentIndent}px)`
      : null
  return {
    cardStyle: cardPaddingLeft ? { paddingLeft: cardPaddingLeft } : undefined,
    parentContentMarginLeft:
      flushSurface && statusLane ? getNewCardStyleParentContentMarginLeft(contentIndent) : 0
  }
}
