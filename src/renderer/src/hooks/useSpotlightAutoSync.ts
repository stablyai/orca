import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { shouldRefreshGitStatusForFileChange } from '@/components/right-sidebar/git-status-file-watch-refresh'
import { splitWorktreeId } from '../../../shared/worktree/id'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  ORCA_WORKTREE_FILE_CHANGE_EVENT,
  type WorktreeFileChangeEventDetail
} from './worktree-file-change-event'

// Why 300ms: agents and editors write files in bursts; one sync per burst is
// enough since the engine also skips no-op syncs by comparing trees.
const SPOTLIGHT_SYNC_DEBOUNCE_MS = 300

/**
 * The automatic half of Spotlight testing: while a workspace holds the
 * Spotlight, mirror every change onto the repo root without the user clicking
 * anything (Conductor-style continuous sync). Mounted once at the app root.
 *
 * Why it does NOT watch the filesystem itself: `useEditorExternalWatch` is the
 * single renderer owner of worktree watch/unwatch (main keys listeners by
 * sender with no refcount, so a second owner's unwatch starves the first). It
 * already includes Spotlight holders in its watch set and re-broadcasts every
 * change as `ORCA_WORKTREE_FILE_CHANGE_EVENT`; this hook only listens.
 */
export function useSpotlightAutoSync(): void {
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const handleFileChange = (event: Event): void => {
      const detail = (event as CustomEvent<WorktreeFileChangeEventDetail>).detail
      if (!detail) {
        return
      }
      const { payload } = detail
      // Find the repo whose holder worktree this change belongs to.
      const holders = useAppStore.getState().spotlightByRepo
      for (const spotlight of Object.values(holders)) {
        const holderPath = splitWorktreeId(spotlight.holderWorktreeId)?.worktreePath
        if (
          !holderPath ||
          normalizeRuntimePathForComparison(payload.worktreePath) !==
            normalizeRuntimePathForComparison(holderPath)
        ) {
          continue
        }
        if (!shouldRefreshGitStatusForFileChange(payload, holderPath)) {
          return
        }
        const repoId = spotlight.repoId
        const pending = timers.get(repoId)
        if (pending) {
          clearTimeout(pending)
        }
        timers.set(
          repoId,
          setTimeout(() => {
            timers.delete(repoId)
            // The holder may have changed or Spotlight turned off during the
            // debounce; sync() no-ops safely (silent 'not-active').
            void useAppStore.getState().syncSpotlight(repoId, { silent: true })
          }, SPOTLIGHT_SYNC_DEBOUNCE_MS)
        )
        return
      }
    }

    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleFileChange as EventListener)
    return () => {
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleFileChange as EventListener)
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
    }
  }, [])
}
