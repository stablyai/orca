/**
 * Stable Zustand snapshots for CollabCanvas session vs panel bindings.
 * Panel boards have no worktree: a fresh `[]` every getSnapshot triggers
 * React #185 (useSyncExternalStore max update depth).
 */
import type { SessionAgentTabLike } from './resolve-session-agent-tab'

export const EMPTY_UNIFIED_TABS: readonly SessionAgentTabLike[] = Object.freeze([])
export const EMPTY_GROUPS: readonly { recentTabIds?: readonly string[] | null }[] = Object.freeze(
  []
)

export function selectUnifiedTabsForSession(
  unifiedTabsByWorktree:
    | Record<string, readonly SessionAgentTabLike[] | undefined>
    | undefined,
  sessionWorktreeId: string | null
): readonly SessionAgentTabLike[] {
  if (!sessionWorktreeId) return EMPTY_UNIFIED_TABS
  return unifiedTabsByWorktree?.[sessionWorktreeId] ?? EMPTY_UNIFIED_TABS
}

export function selectGroupsForSession(
  groupsByWorktree:
    | Record<string, readonly { recentTabIds?: readonly string[] | null }[] | undefined>
    | undefined,
  sessionWorktreeId: string | null
): readonly { recentTabIds?: readonly string[] | null }[] {
  if (!sessionWorktreeId) return EMPTY_GROUPS
  return groupsByWorktree?.[sessionWorktreeId] ?? EMPTY_GROUPS
}
