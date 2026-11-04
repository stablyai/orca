import React, { useMemo } from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { RenderRow } from '../listing/render-row'
import { MAX_PROJECT_GROUP_HEADER_DEPTH, SIDEBAR_TREE_INDENT } from './indentation'
import {
  buildProjectBlockFrames,
  isProjectBlockHeaderRow,
  isProjectGroupLabelRow,
  PROJECT_GROUP_EXIT_GAP,
  type ProjectBlockFrame
} from './project-block-frames'

/** An expanded project group: its label row through the last visible row inside it. */
export type ProjectGroupGuideSpan = {
  level: number
  labelIndex: number
  lastIndex: number
  bottomInset: number
}

// Centers the 1px line in the group's indent step, the gutter left of its projects.
const GUIDE_OFFSET = Math.floor((SIDEBAR_TREE_INDENT - 1) / 2)
// The label text is centered in its 28px row; start the line just below it.
const GUIDE_LABEL_BOTTOM_INSET = 4

function isInsideProjectGroup(row: RenderRow | undefined, depth: number): boolean {
  if (!row || row.type === 'host-header') {
    return false
  }
  if (row.type !== 'header') {
    // Rows are emitted in preorder, so non-header rows belong to the nearest header above.
    return true
  }
  if (!isProjectBlockHeaderRow(row) && !isProjectGroupLabelRow(row)) {
    return false
  }
  return (row.projectGroupDepth ?? 0) > depth
}

export function buildProjectGroupGuideSpans(
  rows: readonly RenderRow[],
  frames: readonly (ProjectBlockFrame | null)[]
): ProjectGroupGuideSpan[] {
  const spans: ProjectGroupGuideSpan[] = []
  rows.forEach((row, labelIndex) => {
    if (!isProjectGroupLabelRow(row)) {
      return
    }
    const depth = Math.max(0, row.projectGroupDepth ?? 0)
    let lastIndex = labelIndex
    while (isInsideProjectGroup(rows[lastIndex + 1], depth)) {
      lastIndex++
    }
    // Collapsed or empty groups have nothing to bracket.
    if (lastIndex === labelIndex) {
      return
    }
    spans.push({
      level: Math.min(depth, MAX_PROJECT_GROUP_HEADER_DEPTH),
      labelIndex,
      lastIndex,
      bottomInset: frames[lastIndex]?.exitGap ? PROJECT_GROUP_EXIT_GAP : 0
    })
  })
  return spans
}

/** Project block frames and group guide spans, rebuilt only when the rows change. */
export function useProjectBlockLayout(rows: readonly RenderRow[]): {
  frames: readonly (ProjectBlockFrame | null)[]
  guideSpans: readonly ProjectGroupGuideSpan[]
} {
  return useMemo(() => {
    const frames = buildProjectBlockFrames(rows)
    return { frames, guideSpans: buildProjectGroupGuideSpans(rows, frames) }
  }, [rows])
}

/** Vertical hairlines in the indent gutter tie an expanded group's projects to its label. */
export function ProjectGroupGuides({
  spans,
  virtualItems
}: {
  spans: readonly ProjectGroupGuideSpan[]
  virtualItems: readonly VirtualItem[]
}): React.JSX.Element | null {
  if (spans.length === 0) {
    return null
  }
  const lines: React.JSX.Element[] = []
  for (const span of spans) {
    let labelBottom: number | null = null
    let firstMemberTop: number | null = null
    let bottom: number | null = null
    for (const item of virtualItems) {
      if (item.index < span.labelIndex || item.index > span.lastIndex) {
        continue
      }
      if (item.index === span.labelIndex) {
        labelBottom = item.end - GUIDE_LABEL_BOTTOM_INSET
        continue
      }
      firstMemberTop = firstMemberTop === null ? item.start : Math.min(firstMemberTop, item.start)
      const end = item.index === span.lastIndex ? item.end - span.bottomInset : item.end
      bottom = bottom === null ? end : Math.max(bottom, end)
    }
    // Only mounted rows have geometry; clipping to them stays offscreen thanks to overscan.
    const top = labelBottom ?? firstMemberTop
    if (top === null || bottom === null || bottom <= top) {
      continue
    }
    lines.push(
      <div
        key={span.labelIndex}
        aria-hidden
        className="pointer-events-none absolute w-px bg-worktree-sidebar-border"
        style={{
          left: span.level * SIDEBAR_TREE_INDENT + GUIDE_OFFSET,
          top,
          height: bottom - top
        }}
      />
    )
  }
  return <>{lines}</>
}
