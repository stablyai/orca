import type React from 'react'
import type { Repo } from '../../../../../../shared/repo-types'
import type { SidebarProjectColorAccentSettings } from '../../../../../../shared/sidebar-list/sections/project-color-accent-settings'
import type { LineageRowFrame } from '../listing/lineage-row-projection'
import { WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP } from '../viewport/virtual-rows'
import { getWorktreeCardSurfaceInset } from './indentation'
import { resolveProjectGroupHeaderColor } from './project-header-color'

// Why: low enough that header text keeps its contrast in light and dark themes, high enough to read as a band.
const PROJECT_COLOR_ACCENT_HEADER_TINT_PERCENT = 12
// Why: sits inside the card surface margin, so the rail never overlaps a card's active/hover surface.
const PROJECT_COLOR_ACCENT_RAIL_OFFSET = 1

export function isProjectColorAccentsEnabled(
  settings: SidebarProjectColorAccentSettings | null | undefined
): boolean {
  return settings?.sidebarProjectColorAccents === true
}

/** The badge color a row under a project header draws as its rail, or undefined when the row has none. */
export function resolveProjectColorAccent(args: {
  enabled: boolean
  groupBy: string
  sectionKey: string
  repo: Pick<Repo, 'badgeColor'> | undefined
}): string | undefined {
  // Why: pinned and folder lanes mix projects; only rows under a project header inherit its color.
  if (!args.enabled || !args.repo) {
    return undefined
  }
  return resolveProjectGroupHeaderColor({
    groupBy: args.groupBy,
    headerKey: args.sectionKey,
    badgeColor: args.repo.badgeColor
  })
}

/** Rail x-offset for a group depth; headers and their rows share it so the rail reads as one line. */
export function getProjectColorAccentRailLeft(groupDepth: number): number {
  return (
    getWorktreeCardSurfaceInset({ isGrouped: true, groupDepth }) + PROJECT_COLOR_ACCENT_RAIL_OFFSET
  )
}

export function getProjectColorAccentRailStyle(
  color: string,
  groupDepth: number,
  frame: Pick<LineageRowFrame, 'before' | 'after' | 'closing'>
): React.CSSProperties {
  return {
    left: getProjectColorAccentRailLeft(groupDepth),
    // Why: rows are spaced by their frame padding; spanning it joins each row's rail to its neighbours.
    top: -(WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP + frame.before),
    bottom: -(frame.after + frame.closing),
    backgroundColor: color
  }
}

export function getProjectColorAccentHeaderTintStyle(
  color: string,
  groupDepth: number
): React.CSSProperties {
  return {
    left: getProjectColorAccentRailLeft(groupDepth),
    borderLeftColor: color,
    backgroundColor: `color-mix(in srgb, ${color} ${PROJECT_COLOR_ACCENT_HEADER_TINT_PERCENT}%, transparent)`
  }
}
