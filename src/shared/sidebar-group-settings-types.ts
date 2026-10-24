import type { CollapsedGroupCountBadgeMode } from './collapsed-group-count-badge'

/** How sidebar workspace groups present their members; kept apart from GlobalSettings, which sits at its max-lines ceiling. */
export type SidebarGroupGlobalSettings = {
  /** Pinned workspaces show in one sidebar location by default; opt in to also show them in their natural groups. */
  showPinnedWorktreesInGroups?: boolean
  /** What a collapsed sidebar group header counts; optional (older profiles), readers default to `off`. */
  collapsedGroupCountBadge?: CollapsedGroupCountBadgeMode
}
