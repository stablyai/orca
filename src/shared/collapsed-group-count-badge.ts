export const COLLAPSED_GROUP_COUNT_BADGE_MODES = ['off', 'attention', 'all'] as const

/** What a collapsed sidebar group header counts: nothing, only workspaces waiting on the
 *  user, or the group total alongside that waiting count. */
export type CollapsedGroupCountBadgeMode = (typeof COLLAPSED_GROUP_COUNT_BADGE_MODES)[number]

export const DEFAULT_COLLAPSED_GROUP_COUNT_BADGE_MODE: CollapsedGroupCountBadgeMode = 'off'

export function resolveCollapsedGroupCountBadgeMode(
  settings?: { collapsedGroupCountBadge?: CollapsedGroupCountBadgeMode } | null
): CollapsedGroupCountBadgeMode {
  const mode = settings?.collapsedGroupCountBadge
  return mode && COLLAPSED_GROUP_COUNT_BADGE_MODES.includes(mode)
    ? mode
    : DEFAULT_COLLAPSED_GROUP_COUNT_BADGE_MODE
}

/** `off` is the only mode that never needs the attention tally, so readers can skip building it. */
export function collapsedGroupCountBadgeNeedsAttention(
  mode: CollapsedGroupCountBadgeMode
): boolean {
  return mode !== 'off'
}
