import type React from 'react'
import { getVirtualRowTransform } from './worktree-list/viewport/virtual-rows'
import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from '../../../../shared/constants'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'
import type { GroupHeaderRow } from '../../../../shared/sidebar-list/row-types'

const PROJECT_GROUP_HEADER_KEY_PREFIX = 'repo:'
const PROVIDER_PROJECT_HEADER_KEY_PREFIX = 'project:'

export function resolveRepoHeaderColor(badgeColor: string | null | undefined): string {
  const normalizedBadgeColor = normalizeRepoBadgeColor(badgeColor)
  if (!normalizedBadgeColor) {
    return DEFAULT_REPO_BADGE_COLOR
  }

  // Why: persisted repo colors are rendered as inline CSS here, so only
  // normalized hex values from the palette or custom picker reach the sidebar.
  return REPO_COLORS.find((repoColor) => repoColor === normalizedBadgeColor) ?? normalizedBadgeColor
}

export function resolveProjectGroupHeaderColor(args: {
  groupBy: string
  headerKey: string
  badgeColor: string | null | undefined
}): string | undefined {
  // Why: pinned/project-folder headers can appear while grouped by repo; only
  // actual project headers should inherit user-authored project colors.
  if (
    args.groupBy !== 'repo' ||
    (!args.headerKey.startsWith(PROJECT_GROUP_HEADER_KEY_PREFIX) &&
      !args.headerKey.startsWith(PROVIDER_PROJECT_HEADER_KEY_PREFIX))
  ) {
    return undefined
  }
  return resolveRepoHeaderColor(args.badgeColor)
}

// User-picked project group color; null keeps the default muted header.
export function resolveProjectGroupAccentColor(
  row: Pick<GroupHeaderRow, 'repo' | 'projectGroup'>
): string | null {
  // Why: the synthetic "Ungrouped" bucket has no stored color.
  if (row.repo || !row.projectGroup || !('color' in row.projectGroup)) {
    return null
  }
  return normalizeRepoBadgeColor(row.projectGroup.color)
}

// Why: a pinned sticky header is opaque; tint it so the group's section color doesn't break at the top.
export function getSectionHeaderRowStyle(
  isActiveStickyHeader: boolean,
  color: string | null,
  start: number
): React.CSSProperties | undefined {
  if (!isActiveStickyHeader) {
    return { transform: getVirtualRowTransform(start) }
  }
  if (!color) {
    return undefined
  }
  // Same shape as ProjectGroupColorBandLayer: rounded top, right-1 inset, left accent edge.
  return {
    backgroundColor: `color-mix(in srgb, ${color} 9%, var(--worktree-sidebar))`,
    boxShadow: `inset 2px 0 0 color-mix(in srgb, ${color} 70%, transparent)`,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    marginRight: 4
  }
}
