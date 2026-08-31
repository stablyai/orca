import type { RuntimeMobileSessionTabGroup } from '../../../shared/runtime-session-contracts'

/**
 * The active-group pointer a mobile snapshot is allowed to publish.
 *
 * Why: a group whose every tab was held back never reaches the client, so naming it would point at
 * something the client was never sent. Falls back to the first group that did publish, then null.
 */
export function resolvePublishedActiveGroupId(
  activeGroupId: string | null,
  publishedGroups: readonly RuntimeMobileSessionTabGroup[] | undefined
): string | null {
  if (activeGroupId && publishedGroups?.some((group) => group.id === activeGroupId)) {
    return activeGroupId
  }
  return publishedGroups?.[0]?.id ?? null
}
