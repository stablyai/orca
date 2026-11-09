import React, { useMemo } from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import { getIndentGuideOffset } from '../rows/indentation'
import { getIndentGuideLevels, getIndentGuideSegments } from './indent-guides'

export function WorktreeSidebarIndentGuides({
  renderRows,
  groupBy,
  virtualItems,
  hidden
}: {
  renderRows: readonly RenderRow[]
  groupBy: WorktreeGroupBy
  virtualItems: readonly VirtualItem[]
  hidden: boolean
}): React.JSX.Element | null {
  const levels = useMemo(() => getIndentGuideLevels(renderRows, groupBy), [renderRows, groupBy])
  // Why: rows slide by preview offsets mid-drag; static guides would cut across them.
  if (hidden) {
    return null
  }
  const segments = getIndentGuideSegments(levels, virtualItems)
  if (segments.length === 0) {
    return null
  }
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {segments.map((segment) => (
        <div
          key={`${segment.level}:${segment.top}`}
          className="absolute w-px bg-worktree-sidebar-border"
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
