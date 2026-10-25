import React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

type WorkspaceCleanupListRow = { worktreeId: string }

// Keep small fleets in natural flow; window only large lists where streaming/typing incurs O(N) churn.
export const WORKSPACE_CLEANUP_VIRTUALIZE_MIN_ROWS = 40
// Estimate collapsed row height; measureElement corrects expanded rows and error banners.
const WORKSPACE_CLEANUP_ROW_ESTIMATE_PX = 48
const WORKSPACE_CLEANUP_ROW_OVERSCAN = 8

/** Window large lists in their dedicated ScrollArea; no sibling content means zero scroll margin. */
export function WorkspaceCleanupCandidateList<Row extends WorkspaceCleanupListRow>({
  rows,
  renderRow,
  getRowKey,
  estimatedRowHeight = WORKSPACE_CLEANUP_ROW_ESTIMATE_PX,
  // Track viewport attachment in state; a ref alone arrives too late for initial virtualizer observation.
  scrollElement
}: {
  rows: readonly Row[]
  renderRow: (row: Row, index: number) => React.ReactNode
  // Require host-qualified keys at compile time because worktree IDs collide across hosts.
  getRowKey: (row: Row) => string
  estimatedRowHeight?: number
  scrollElement: HTMLDivElement | null
}): React.JSX.Element {
  const virtualize = rows.length >= WORKSPACE_CLEANUP_VIRTUALIZE_MIN_ROWS

  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: virtualize && scrollElement !== null,
    getScrollElement: () => scrollElement,
    estimateSize: () => estimatedRowHeight,
    overscan: WORKSPACE_CLEANUP_ROW_OVERSCAN,
    // Stable keys preserve row identity across streamed scan refreshes.
    getItemKey: (index) => {
      const row = rows[index]
      return row === undefined ? index : getRowKey(row)
    }
  })

  if (!virtualize) {
    return <>{rows.map((candidate, index) => renderRow(candidate, index))}</>
  }

  return (
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const candidate = rows[item.index]
        if (candidate === undefined) {
          return null
        }
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {renderRow(candidate, item.index)}
          </div>
        )
      })}
    </div>
  )
}
