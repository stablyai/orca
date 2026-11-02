import { defaultRangeExtractor } from '@tanstack/react-virtual'
import type { Range, VirtualItem } from '@tanstack/react-virtual'
import {
  PINNED_GROUP_KEY,
  getWorktreeLineageGroupKey
} from '../../../../../../shared/sidebar-list/group-keys'
import { getRenderRowKey } from '../listing/render-row'
import type { RenderRow } from '../listing/render-row'

export const GROUP_HEADER_ROW_HEIGHT = 28
// Why: HostSectionHeader wraps its h-8 (32px) card in pt-1 (4px), so the row is 36px.
export const HOST_HEADER_ROW_HEIGHT = 36
export const WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP = 6
const SECONDARY_GROUP_HEADER_TOP_MARGIN = 4
const IMPORTED_WORKTREES_LINE_ROW_HEIGHT = 36
const PENDING_CREATION_ROW_HEIGHT = 56
const FOLDER_WORKSPACE_ROW_HEIGHT = 64

/** Remap anchors when first/last child changes flip a parent between plain and lineage-group keys without moving it. */
export function buildLineageRowRekeyMap(rows: readonly RenderRow[]): ReadonlyMap<string, string> {
  const rekeyed = new Map<string, string>()
  for (const row of rows) {
    if (row.type === 'lineage-group') {
      const groupKey = getRenderRowKey(row)
      for (const member of row.rows) {
        rekeyed.set(`wt:${member.rowKey}`, groupKey)
      }
      continue
    }
    if (row.type !== 'item') {
      continue
    }
    // Map dissolved groups even with zero children because old anchors still hold their group key.
    rekeyed.set(
      `lineage-group:${row.sectionKey}:${getWorktreeLineageGroupKey(row.worktree)}`,
      getRenderRowKey(row)
    )
  }
  return rekeyed
}

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
  if (row?.type === 'imported-worktrees-card' || row?.type === 'new-external-worktrees-inbox') {
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

export function getVirtualRowIndex(element: Element): number | null {
  const index = Number.parseInt(element.getAttribute('data-index') ?? '', 10)
  return Number.isNaN(index) ? null : index
}

export function getVirtualRowKey(element: Element): string | null {
  return element.getAttribute('data-worktree-virtual-row-key')
}

export function getWorktreeVirtualRowTransform(start: number, previewOffset: number): string {
  const base = getVirtualRowTransform(start)
  return previewOffset === 0 ? base : `${base} translateY(${previewOffset}px)`
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
    // Drop disconnected measured nodes after TanStack cleanup so their React fibers cannot retain old card scopes.
    virtualizer.elementsCache.delete(key)
  }
}

export function getStickyHeaderIndexes(rows: readonly RenderRow[]): number[] {
  const indexes: number[] = []
  rows.forEach((row, index) => {
    // Pin top-level project groups rather than nested repo headers.
    if (
      row.type === 'host-header' ||
      (row.type === 'header' && (row.projectGroupDepth ?? 0) === 0)
    ) {
      indexes.push(index)
    }
  })
  return indexes
}

// Keep pinned host height in sync with HostSectionHeader; its group tier pins one pixel up.
export const HOST_STICKY_PINNED_HEIGHT = HOST_HEADER_ROW_HEIGHT

export type ActiveStickyIndexes = {
  /** Pinned host card (tier 1), or null outside host sections. */
  hostIndex: number | null
  /** Pinned group header (tier 2), offset below the host when one is pinned. */
  groupIndex: number | null
}

function getHostStickyIndexes(rows: readonly RenderRow[], sticky: readonly number[]): number[] {
  return sticky.filter((index) => rows[index]?.type === 'host-header')
}

/** Keep the host pinned while groups hand off below it; without hosts, use a single sticky tier. */
export function getActiveStickyIndexesForScroll(args: {
  rows: readonly RenderRow[]
  rangeStartIndex: number
  scrollOffset: number
  stickyHeaderIndexes: readonly number[]
  virtualItems: readonly VirtualItem[]
}): ActiveStickyIndexes {
  const hostIndexes = getHostStickyIndexes(args.rows, args.stickyHeaderIndexes)
  const virtualItemsByIndex = new Map(args.virtualItems.map((item) => [item.index, item]))

  const resolveWithHandoff = (
    candidates: readonly number[],
    pinnedOffset: number,
    fallbackToCandidate: boolean
  ): number | null => {
    // The group slot can reach a header before the viewport's range start does.
    const candidateIndex =
      candidates.findLast(
        (index) =>
          index <= args.rangeStartIndex ||
          (virtualItemsByIndex.get(index)?.start ?? Number.POSITIVE_INFINITY) <=
            args.scrollOffset + pinnedOffset
      ) ?? null
    if (candidateIndex === null) {
      return null
    }
    const candidate = virtualItemsByIndex.get(candidateIndex)
    if (!candidate) {
      // Reveal may precede mounting; prefer previous measured stickies, and defer group pinning without geometry.
      const previous = getPreviousStickyHeaderIndex(candidates, candidateIndex)
      if (previous !== null) {
        const previousItem = virtualItemsByIndex.get(previous)
        if (previousItem) {
          return previous
        }
      }
      return fallbackToCandidate ? candidateIndex : null
    }
    // Hand off when the incoming header reaches its pinned slot, including any host offset.
    if (args.scrollOffset + pinnedOffset >= candidate.start) {
      return candidateIndex
    }
    const previous = getPreviousStickyHeaderIndex(candidates, candidateIndex)
    if (previous !== null) {
      return previous
    }
    // The first group stays in flow until it reaches the host’s lower edge; only hosts retain the legacy fallback.
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
    // Only groups inside the current pinned host’s section may pin beneath it.
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
  // Keep the pinned host mounted even when it is far above the visible group range.
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

  // Pin as the header reaches the top; waiting for its spacer would leave the previous header covering it.
  if (args.scrollOffset >= candidate.start) {
    return candidateIndex
  }

  return getPreviousStickyHeaderIndex(args.stickyHeaderIndexes, candidateIndex) ?? candidateIndex
}
