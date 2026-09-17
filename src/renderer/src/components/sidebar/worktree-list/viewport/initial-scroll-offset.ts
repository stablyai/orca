import type { RenderRow } from '../listing/render-row'
import { estimateRenderRowSize, WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP } from './virtual-rows'

export function estimateRenderRowsTotalSize(
  rows: readonly RenderRow[],
  firstHeaderIndex: number
): number {
  return rows.reduce(
    (total, _row, index) =>
      total +
      estimateRenderRowSize(rows, index, firstHeaderIndex, null) +
      (index === rows.length - 1 ? 0 : WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP),
    0
  )
}

export function clampInitialVirtualScrollOffset(args: {
  requestedOffset: number
  estimatedTotalSize: number
  viewportHeight: number
}): number {
  if (args.viewportHeight <= 0) {
    return args.requestedOffset
  }
  return Math.min(
    Math.max(0, args.requestedOffset),
    Math.max(0, args.estimatedTotalSize - args.viewportHeight)
  )
}
