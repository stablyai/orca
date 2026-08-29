export type PinnedWorktreeDisplayPolicy = 'single-location' | 'duplicate-in-groups'

/** Absent/false is the single-location default, so hosts predating the setting fall back to it. */
export function getPinnedWorktreeDisplayPolicy(
  settings?: { showPinnedWorktreesInGroups?: boolean } | null
): PinnedWorktreeDisplayPolicy {
  return settings?.showPinnedWorktreesInGroups === true ? 'duplicate-in-groups' : 'single-location'
}
