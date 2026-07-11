import React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'

// Why: below this count plain rows keep the pre-virtualization DOM (natural
// flow, no absolute positioning), so the common few-worktrees case is
// byte-for-byte unchanged. The O(N) stream-in churn and per-keystroke re-render
// only bite at the hundreds-to-thousands a heavy multi-agent user accumulates.
export const WORKSPACE_CLEANUP_VIRTUALIZE_MIN_ROWS = 40
// Why: a collapsed row is a single metadata line (~48px with px-3 py-2.5);
// expanded rows and failure banners are taller, so estimate the common height
// and let measureElement correct the tall variants.
const WORKSPACE_CLEANUP_ROW_ESTIMATE_PX = 48
const WORKSPACE_CLEANUP_ROW_OVERSCAN = 8

/**
 * Windows the cleanup candidate rows inside the dialog's ScrollArea viewport.
 * The list is the viewport's only content, so rows sit at scroll offset 0 and
 * no scroll-margin bookkeeping is needed. Lists shorter than
 * WORKSPACE_CLEANUP_VIRTUALIZE_MIN_ROWS render plainly.
 */
export function WorkspaceCleanupCandidateList({
  rows,
  renderRow,
  // Why: a state-held element, not a ref — the ScrollArea viewport is not
  // attached when this component first mounts, so a ref would leave the
  // virtualizer unobserved until some unrelated re-render.
  scrollElement
}: {
  rows: readonly WorkspaceCleanupCandidate[]
  renderRow: (candidate: WorkspaceCleanupCandidate, index: number) => React.ReactNode
  scrollElement: HTMLDivElement | null
}): React.JSX.Element {
  const virtualize = rows.length >= WORKSPACE_CLEANUP_VIRTUALIZE_MIN_ROWS

  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: virtualize && scrollElement !== null,
    getScrollElement: () => scrollElement,
    estimateSize: () => WORKSPACE_CLEANUP_ROW_ESTIMATE_PX,
    overscan: WORKSPACE_CLEANUP_ROW_OVERSCAN,
    // Why: stable worktree keys let the virtualizer carry row identity across
    // scan refreshes instead of remounting the window on every streamed row.
    getItemKey: (index) => rows[index]?.worktreeId ?? index
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
