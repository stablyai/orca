import { useAppStore } from '@/store'

/** Display name of the workspace currently holding the repo's Spotlight, or
 *  undefined when none. Returns a primitive so subscribers only re-render when
 *  the holder's name actually changes — not on every debounced sync. Shared by
 *  the quick-action button and the primary-row badge. */
export function useSpotlightHolderName(repoId: string): string | undefined {
  return useAppStore((s) => {
    const holderId = s.spotlightByRepo?.[repoId]?.holderWorktreeId
    if (!holderId) {
      return undefined
    }
    return s.worktreesByRepo?.[repoId]?.find((entry) => entry.id === holderId)?.displayName
  })
}
