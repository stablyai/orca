import React, { useMemo } from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import { renderRowContainsWorktree } from '../navigation/render-row-lookup'
import { getIndentGuideOffset } from '../rows/indentation'
import { getIndentGuideAncestors, getIndentGuideSegments } from './indent-guides'

export function WorktreeSidebarIndentGuides({
  renderRows,
  groupBy,
  virtualItems,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  hidden
}: {
  renderRows: readonly RenderRow[]
  groupBy: WorktreeGroupBy
  virtualItems: readonly VirtualItem[]
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  hidden: boolean
}): React.JSX.Element | null {
  const ancestors = useMemo(
    () => getIndentGuideAncestors(renderRows, groupBy),
    [renderRows, groupBy]
  )
  const activeAncestors = useMemo(() => {
    const index = renderRows.findIndex((row) =>
      renderRowContainsWorktree(row, activeWorktreeId, activeWorkspaceExecutionHostId ?? undefined)
    )
    return new Set(index === -1 ? [] : ancestors[index].map((ancestor) => ancestor.key))
  }, [renderRows, ancestors, activeWorktreeId, activeWorkspaceExecutionHostId])
  // Why: rows slide by preview offsets mid-drag; static guides would cut across them.
  if (hidden) {
    return null
  }
  const segments = getIndentGuideSegments(ancestors, virtualItems, activeAncestors)
  if (segments.length === 0) {
    return null
  }
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {segments.map((segment) => (
        <div
          key={`${segment.key}:${segment.top}`}
          className={cn(
            'absolute w-px',
            segment.active
              ? 'bg-worktree-sidebar-foreground/45'
              : 'bg-worktree-sidebar-foreground/15'
          )}
          style={{
            left: getIndentGuideOffset(segment.level),
            top: segment.top,
            height: segment.bottom - segment.top
          }}
        />
      ))}
    </div>
  )
}
