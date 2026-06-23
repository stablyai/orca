import { defaultRangeExtractor } from '@tanstack/react-virtual'
import type { Range, VirtualItem } from '@tanstack/react-virtual'
import type { HostSectionRow } from './host-section-rows'
import { PINNED_GROUP_KEY } from './worktree-list-groups'

export const GROUP_HEADER_ROW_HEIGHT = 28
export const HOST_HEADER_ROW_HEIGHT = 32
const SECONDARY_GROUP_HEADER_TOP_MARGIN = 4
const IMPORTED_WORKTREES_LINE_ROW_HEIGHT = 36
const PENDING_CREATION_ROW_HEIGHT = 56
const FOLDER_WORKSPACE_ROW_HEIGHT = 64

type WorktreeItemRow = Extract<HostSectionRow, { type: 'item' }>
export type RenderRow =
  | HostSectionRow
  | { type: 'lineage-group'; key: string; rows: WorktreeItemRow[] }

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
  if (row?.type === 'host-header') {
    return (
      HOST_HEADER_ROW_HEIGHT +
      (shouldUseHeaderTopSpacing({
        rows,
        index,
        firstHeaderIndex
      })
        ? SECONDARY_GROUP_HEADER_TOP_MARGIN
        : 0)
    )
  }
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
    return IMPORTED_WORKTREES_LINE_ROW_HEIGHT
  }
  if (row?.type === 'pending-creation') {
    return PENDING_CREATION_ROW_HEIGHT
  }
  if (row?.type === 'folder-workspace') {
    return FOLDER_WORKSPACE_ROW_HEIGHT
  }
  return 116
}

export function getVirtualRowTransform(start: number): string {
  return `translateY(${start}px)`
}

type VirtualRowElementCache<TElement extends Element> = {
  elementsCache: Map<unknown, TElement>
  measureElement: (node: TElement | null) => void
}

export function pruneStaleVirtualRowElementCache<TElement extends Element>({
  activeRowKeys,
  virtualizer
}: {
  activeRowKeys: ReadonlySet<string>
  virtualizer: VirtualRowElementCache<TElement>
}): void {
  virtualizer.measureElement(null)
  for (const [key, element] of virtualizer.elementsCache) {
    const rowKey = String(key)
    if (activeRowKeys.has(rowKey) || element.isConnected) {
      continue
    }
    // Why: measured row nodes retain their React fiber tree. Once TanStack's
    // public null-measure cleanup has run, drop any disconnected stale key left
    // behind so old WorktreeCard scopes do not survive runtime-host row churn.
    virtualizer.elementsCache.delete(key)
  }
}

export function getStickyHeaderIndexes(rows: readonly RenderRow[]): number[] {
  const indexes: number[] = []
  rows.forEach((row, index) => {
    // Why: project groups are the top-level repo sidebar context; nested repo
    // headers should not replace their containing group as the pinned header.
    if (
      row.type === 'host-header' ||
      (row.type === 'header' && (row.projectGroupDepth ?? 0) === 0)
    ) {
      indexes.push(index)
    }
  })
  return indexes
}

// Why: the pinned host card is h-8 (32px) inside a pt-1 (4px) wrapper; the
// group tier pins one pixel up to sit flush beneath it. Keep in sync with
// HostSectionHeader's layout.
export const HOST_STICKY_PINNED_HEIGHT = 36

export type ActiveStickyIndexes = {
  /** Pinned host card (tier 1), or null outside host sections. */
  hostIndex: number | null
  /** Pinned group header (tier 2), offset below the host when one is pinned. */
  groupIndex: number | null
}

function getHostStickyIndexes(rows: readonly RenderRow[], sticky: readonly number[]): number[] {
  return sticky.filter((index) => rows[index]?.type === 'host-header')
}

/** Two-tier sticky resolution: the host card is the outer hierarchy level so
 *  it stays pinned for the whole section while group headers hand off beneath
 *  it. Without host sections this degrades to the original single-tier rules. */
export function getActiveStickyIndexesForScroll(args: {
  rows: readonly RenderRow[]
  rangeStartIndex: number
  scrollOffset: number
  stickyHeaderIndexes: readonly number[]
  virtualItems: readonly VirtualItem[]
}): ActiveStickyIndexes {
  const hostIndexes = getHostStickyIndexes(args.rows, args.stickyHeaderIndexes)

  const resolveWithHandoff = (
    candidates: readonly number[],
    pinnedOffset: number,
    fallbackToCandidate: boolean
  ): number | null => {
    const candidateIndex = getActiveStickyHeaderIndex(candidates, args.rangeStartIndex)
    if (candidateIndex === null) {
      return null
    }
    const candidate = args.virtualItems.find((item) => item.index === candidateIndex)
    if (!candidate) {
      return candidateIndex
    }
    // Why: hand off the moment the incoming header reaches its pinned slot
    // (top of the viewport, or the bottom edge of the pinned host card).
    if (args.scrollOffset + pinnedOffset >= candidate.start) {
      return candidateIndex
    }
    const previous = getPreviousStickyHeaderIndex(candidates, candidateIndex)
    if (previous !== null) {
      return previous
    }
    // Why: a host section's first group is still in flow below the pinned
    // host card until it reaches the slot — pinning it early would double
    // it up. The host tier keeps the legacy fallback.
    return fallbackToCandidate ? candidateIndex : null
  }

  const hostIndex = resolveWithHandoff(hostIndexes, 0, true)

  const hostPosition = hostIndex === null ? -1 : hostIndexes.indexOf(hostIndex)
  const nextHostIndex =
    hostPosition >= 0 ? (hostIndexes[hostPosition + 1] ?? Number.POSITIVE_INFINITY) : null
  const groupIndexes = args.stickyHeaderIndexes.filter((index) => {
    if (args.rows[index]?.type !== 'header') {
      return false
    }
    // Why: a group from the previous host must never pin beneath the next
    // host's card — only groups inside the pinned host's section qualify.
    if (hostIndex !== null) {
      return index > hostIndex && index < (nextHostIndex ?? Number.POSITIVE_INFINITY)
    }
    return true
  })
  const groupIndex = resolveWithHandoff(
    groupIndexes,
    hostIndex !== null ? HOST_STICKY_PINNED_HEIGHT : 0,
    hostIndex === null
  )

  return { hostIndex, groupIndex }
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

export function extractWorktreeVirtualRowIndexes(args: {
  range: Range
  stickyHeaderIndexes: readonly number[]
  rows?: readonly RenderRow[]
}): number[] {
  const activeStickyHeaderIndex = getActiveStickyHeaderIndex(
    args.stickyHeaderIndexes,
    args.range.startIndex
  )
  if (activeStickyHeaderIndex === null) {
    return defaultRangeExtractor(args.range)
  }

  const previousStickyHeaderIndex = getPreviousStickyHeaderIndex(
    args.stickyHeaderIndexes,
    activeStickyHeaderIndex
  )
  // Why: the pinned host card (tier 1) can be far above the visible range
  // while group headers hand off beneath it — keep it mounted regardless.
  const hostIndexes = args.rows ? getHostStickyIndexes(args.rows, args.stickyHeaderIndexes) : []
  const activeHostIndex = getActiveStickyHeaderIndex(hostIndexes, args.range.startIndex)
  return Array.from(
    new Set([
      activeStickyHeaderIndex,
      ...(previousStickyHeaderIndex === null ? [] : [previousStickyHeaderIndex]),
      ...(activeHostIndex === null ? [] : [activeHostIndex]),
      ...defaultRangeExtractor(args.range)
    ])
  ).sort((a, b) => a - b)
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
