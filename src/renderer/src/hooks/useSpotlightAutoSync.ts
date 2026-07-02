import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { shouldRefreshGitStatusForFileChange } from '@/components/right-sidebar/git-status-file-watch-refresh'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'

// Why 300ms: agents and editors write files in bursts; one sync per burst is
// enough since the engine also skips no-op syncs by comparing trees.
const SPOTLIGHT_SYNC_DEBOUNCE_MS = 300

type SpotlightHolder = {
  repoId: string
  /** Filesystem path of the worktree holding the Spotlight. */
  path: string
}

/**
 * The automatic half of Spotlight testing: while a workspace holds the
 * Spotlight, watch its files and mirror every change onto the repo root
 * without the user clicking anything (Conductor-style continuous sync).
 * Mounted once at the app root.
 */
export function useSpotlightAutoSync(): void {
  const spotlightByRepo = useAppStore((s) => s.spotlightByRepo)

  const holders = useMemo<SpotlightHolder[]>(() => {
    return Object.values(spotlightByRepo).flatMap((state) => {
      const prefix = `${state.repoId}::`
      if (!state.holderWorktreeId.startsWith(prefix)) {
        return []
      }
      return [{ repoId: state.repoId, path: state.holderWorktreeId.slice(prefix.length) }]
    })
  }, [spotlightByRepo])
  // Why a string key: `holders` is a fresh array each store change; keying the
  // effect on identity would tear down and re-create watchers on every sync.
  const holdersKey = holders.map((holder) => `${holder.repoId}::${holder.path}`).join('\n')

  useEffect(() => {
    if (holders.length === 0) {
      return
    }
    for (const holder of holders) {
      void window.api.fs.watchWorktree({ worktreePath: holder.path }).catch(() => {
        // Non-fatal: without a watcher the user can still re-sync by toggling.
      })
    }

    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const unsubscribe = window.api.fs.onFsChanged((payload) => {
      const holder = holders.find(
        (entry) =>
          normalizeRuntimePathForComparison(payload.worktreePath) ===
          normalizeRuntimePathForComparison(entry.path)
      )
      if (!holder || !shouldRefreshGitStatusForFileChange(payload, holder.path)) {
        return
      }
      const pending = timers.get(holder.repoId)
      if (pending) {
        clearTimeout(pending)
      }
      timers.set(
        holder.repoId,
        setTimeout(() => {
          timers.delete(holder.repoId)
          const current = useAppStore.getState().spotlightByRepo[holder.repoId]
          // The user may have turned Spotlight off (or moved it) between the
          // file event and this debounce firing — don't sync a stale holder.
          if (current?.holderWorktreeId !== `${holder.repoId}::${holder.path}`) {
            return
          }
          void useAppStore.getState().syncSpotlight(holder.repoId, { silent: true })
        }, SPOTLIGHT_SYNC_DEBOUNCE_MS)
      )
    })

    return () => {
      unsubscribe()
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      for (const holder of holders) {
        void window.api.fs.unwatchWorktree({ worktreePath: holder.path }).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- holdersKey encodes holders
  }, [holdersKey])
}
