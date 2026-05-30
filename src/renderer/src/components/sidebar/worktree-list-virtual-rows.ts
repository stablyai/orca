import type { VirtualItem } from '@tanstack/react-virtual'
import type { Row } from './worktree-list-groups'
import { PINNED_GROUP_KEY } from './worktree-list-groups'

export const GROUP_HEADER_ROW_HEIGHT = 28
const SECONDARY_GROUP_HEADER_TOP_MARGIN = 8
const IMPORTED_WORKTREES_CARD_ROW_HEIGHT = 224

type WorktreeItemRow = Extract<Row, { type: 'item' }>
export type RenderRow = Row | { type: 'lineage-group'; key: string; rows: WorktreeItemRow[] }

export function shouldUseHeaderTopSpacing(args: {
  rows: readonly RenderRow[]
  index: number
  firstHeaderIndex: number
}): boolean {
  const previousRenderRow = args.rows[args.index - 1]
  const followsCollapsedPinnedHeader =
    previousRenderRow?.type === 'header' && previousRenderRow.key === PINNED_GROUP_KEY
  return args.index !== args.firstHeaderIndex && !followsCollapsedPinnedHeader
}

export function estimateRenderRowSize(
  rows: readonly RenderRow[],
  index: number,
  firstHeaderIndex: number,
  _activeStickyHeaderIndex: number | null
): number {
  const row = rows[index]
  if (row?.type === 'header') {
    return (
      GROUP_HEADER_ROW_HEIGHT +
      (shouldUseHeaderTopSpacing({
        rows,
        index,
        firstHeaderIndex
      })
        ? SECONDARY_GROUP_HEADER_TOP_MARGIN
        : 0)
    )
  }
  if (row?.type === 'lineage-group') {
    return 100 + Math.max(0, row.rows.length - 1) * 96
  }
  if (row?.type === 'imported-worktrees-card') {
    return IMPORTED_WORKTREES_CARD_ROW_HEIGHT
  }
  return 116
}

export function getVirtualRowTransform(start: number): string {
  return `translateY(${start}px)`
}

export function getStickyHeaderIndexes(rows: readonly RenderRow[]): number[] {
  const indexes: number[] = []
  rows.forEach((row, index) => {
    if (row.type === 'header') {
      indexes.push(index)
    }
  })
  return indexes
}

export function getActiveStickyHeaderIndex(
  stickyHeaderIndexes: readonly number[],
  rangeStartIndex: number
): number | null {
  for (let index = stickyHeaderIndexes.length - 1; index >= 0; index--) {
    const headerIndex = stickyHeaderIndexes[index]
    if (headerIndex <= rangeStartIndex) {
      return headerIndex
    }
  }
  return null
}

export function getPreviousStickyHeaderIndex(
  stickyHeaderIndexes: readonly number[],
  headerIndex: number
): number | null {
  const currentPosition = stickyHeaderIndexes.indexOf(headerIndex)
  if (currentPosition <= 0) {
    return null
  }
  return stickyHeaderIndexes[currentPosition - 1] ?? null
}

export function getActiveStickyHeaderIndexForScroll(args: {
  rangeStartIndex: number
  scrollOffset: number
  stickyHeaderIndexes: readonly number[]
  virtualItems: readonly VirtualItem[]
}): number | null {
  const candidateIndex = getActiveStickyHeaderIndex(args.stickyHeaderIndexes, args.rangeStartIndex)
  if (candidateIndex === null) {
    return null
  }

  const candidate = args.virtualItems.find((item) => item.index === candidateIndex)
  if (!candidate) {
    return candidateIndex
  }

  // Why: hand off the moment the candidate header's row reaches the top, so the
  // incoming repo pins as soon as its group begins. Gating on start + spacer
  // instead kept the previous repo's opaque header pinned over the incoming one
  // for the height of its inter-group spacer.
  if (args.scrollOffset >= candidate.start) {
    return candidateIndex
  }

  return getPreviousStickyHeaderIndex(args.stickyHeaderIndexes, candidateIndex) ?? candidateIndex
}
