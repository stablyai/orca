import type React from 'react'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import {
  MAX_PROJECT_GROUP_HEADER_DEPTH,
  PROJECT_GROUP_HEADER_BASE_PADDING,
  SIDEBAR_TREE_INDENT
} from './indentation'

// A project block is a repo header plus every row up to the next header. Virtual rows are
// absolutely positioned, so each row draws its own slice of the block (see main.css).
export type ProjectBlockPosition = 'start' | 'middle' | 'end' | 'single'

export type ProjectBlockFrame = {
  position: ProjectBlockPosition
  depth: number
  /** Last block of a project group with a shallower project right after it. */
  exitGap?: boolean
}

// Header rows are not DOM-measured; keep in sync with estimateRenderRowSize.
export const PROJECT_BLOCK_HEADER_ROW_HEIGHT = 32
const PROJECT_BLOCK_BORDER = 1
// Inside a project block the 1px border already offsets the header content.
export const PROJECT_BLOCK_HEADER_PADDING_LEFT =
  PROJECT_GROUP_HEADER_BASE_PADDING - PROJECT_BLOCK_BORDER
const PROJECT_BLOCK_RIGHT_INSET = 4
// Matches the card surface's left margin so cards sit evenly inside the block.
const PROJECT_BLOCK_CONTENT_GUTTER = 4
// Why: without it a collapsed group label reads as the heading of the ungrouped project below it.
export const PROJECT_GROUP_EXIT_GAP = 12

export function isProjectBlockHeaderRow(row: RenderRow | undefined): boolean {
  return row?.type === 'header' && row.repo !== undefined
}

export function isProjectGroupLabelRow(
  row: RenderRow | undefined
): row is Extract<RenderRow, { type: 'header' }> {
  return row?.type === 'header' && !row.repo && typeof row.projectGroup?.id === 'string'
}

/** True when the row ends a project group section and the next row is a project outside it. */
export function hasProjectGroupExitGap(
  rows: readonly RenderRow[],
  index: number,
  blockDepth: number | null
): boolean {
  const next = rows[index + 1]
  if (next?.type !== 'header' || !isProjectBlockHeaderRow(next)) {
    return false
  }
  const nextDepth = next.projectGroupDepth ?? 0
  const row = rows[index]
  if (isProjectGroupLabelRow(row)) {
    // A label directly followed by a project at its own depth is collapsed or empty.
    return (row.projectGroupDepth ?? 0) >= nextDepth
  }
  return blockDepth !== null && blockDepth > nextDepth
}

function isProjectBlockMemberRow(row: RenderRow | undefined): boolean {
  return row !== undefined && row.type !== 'header' && row.type !== 'host-header'
}

export function buildProjectBlockFrames(
  rows: readonly RenderRow[]
): readonly (ProjectBlockFrame | null)[] {
  const frames: (ProjectBlockFrame | null)[] = Array.from({ length: rows.length }, () => null)
  let index = 0
  while (index < rows.length) {
    const row = rows[index]
    if (row?.type !== 'header' || !isProjectBlockHeaderRow(row)) {
      index++
      continue
    }
    let end = index
    while (isProjectBlockMemberRow(rows[end + 1])) {
      end++
    }
    const rawDepth = Math.max(0, row.projectGroupDepth ?? 0)
    const depth = Math.min(rawDepth, MAX_PROJECT_GROUP_HEADER_DEPTH)
    const exitGap = hasProjectGroupExitGap(rows, end, rawDepth)
    if (end === index) {
      frames[index] = { position: 'single', depth, exitGap }
    } else {
      frames[index] = { position: 'start', depth }
      for (let member = index + 1; member < end; member++) {
        frames[member] = { position: 'middle', depth }
      }
      frames[end] = { position: 'end', depth, exitGap }
    }
    index = end + 1
  }
  return frames
}

export function getProjectBlockRowAttributes(
  frame: ProjectBlockFrame | null | undefined,
  baseStyle?: React.CSSProperties
): { 'data-project-block'?: ProjectBlockPosition; style?: React.CSSProperties } {
  if (!frame) {
    return baseStyle ? { style: baseStyle } : {}
  }
  const left = frame.depth * SIDEBAR_TREE_INDENT
  const isHeader = frame.position === 'start' || frame.position === 'single'
  const style: React.CSSProperties & Record<`--${string}`, string> = {
    ...baseStyle,
    '--project-block-left': `${left}px`,
    '--project-block-right': `${PROJECT_BLOCK_RIGHT_INSET}px`,
    paddingLeft: left + PROJECT_BLOCK_BORDER,
    paddingRight:
      PROJECT_BLOCK_RIGHT_INSET +
      PROJECT_BLOCK_BORDER +
      (isHeader ? 0 : PROJECT_BLOCK_CONTENT_GUTTER)
  }
  const exitGap = frame.exitGap ? PROJECT_GROUP_EXIT_GAP : 0
  if (isHeader) {
    style.height = PROJECT_BLOCK_HEADER_ROW_HEIGHT + exitGap
    style.paddingTop = PROJECT_BLOCK_BORDER
  }
  if (frame.position === 'single') {
    style.paddingBottom = PROJECT_BLOCK_BORDER + exitGap
  } else if (frame.position === 'end') {
    style.paddingBottom = PROJECT_BLOCK_BORDER + PROJECT_BLOCK_CONTENT_GUTTER + exitGap
  }
  if (exitGap > 0) {
    // The gap sits below the block, outside its painted surface.
    style['--project-block-bottom'] = `${exitGap}px`
  }
  return { 'data-project-block': frame.position, style }
}

/** Section headers: project headers join their block; a collapsed group label may carry the exit gap. */
export function getSectionHeaderBlockState(args: {
  row: GroupHeaderRow
  /** Only for project headers. */
  projectBlock: ProjectBlockFrame | null
  isHeaderCollapsed: boolean
  hasGroupExitGap: boolean
  activeWorktreeId: string | null
  /** Undefined while the header is pinned. */
  transform: string | undefined
}): {
  inProjectBlock: boolean
  isCollapsedProject: boolean
  attributes: {
    'data-project-block'?: ProjectBlockPosition
    'data-project-block-current'?: ''
    style?: React.CSSProperties
  }
} {
  const { row, projectBlock, transform } = args
  const inProjectBlock = projectBlock !== null
  const baseStyle: React.CSSProperties | undefined =
    transform === undefined
      ? undefined
      : {
          transform,
          // Why: like pt-1, the spacer drops once the label pins.
          ...(args.hasGroupExitGap && !inProjectBlock
            ? { paddingBottom: PROJECT_GROUP_EXIT_GAP }
            : null)
        }
  const isCollapsedProject = inProjectBlock && args.isHeaderCollapsed && row.count > 0
  // Why: a collapsed project hides the open workspace, so its block takes the active recipe instead.
  const holdsActiveWorkspace =
    isCollapsedProject &&
    args.activeWorktreeId !== null &&
    (row.worktreeIds?.includes(args.activeWorktreeId) ?? false)
  const attributes = getProjectBlockRowAttributes(projectBlock, baseStyle)
  return {
    inProjectBlock,
    isCollapsedProject,
    attributes: holdsActiveWorkspace
      ? { ...attributes, 'data-project-block-current': '' }
      : attributes
  }
}
