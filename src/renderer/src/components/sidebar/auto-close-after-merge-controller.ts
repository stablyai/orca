import type { StoreApi } from 'zustand'
import { useAppStore } from '@/store'
import type { AppState } from '@/store'
import { branchName } from '@/lib/git-utils'
import { runWorktreeDeleteWithToast } from './delete-worktree-flow'

type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

/**
 * Auto-close a worktree once its linked PR transitions to `merged`.
 *
 * Why a headless store subscriber (and not a hook inside SourceControl.tsx):
 * SourceControl only mounts while the right sidebar is visible, but the PR
 * polling that discovers a merge keeps running regardless (fetchPRForBranch
 * is called on any sidebar open, worktree switch, or manual refresh). Wiring
 * the auto-close reaction at App level guarantees we honor a merge the moment
 * the cache reports it — even if the user is heads-down in the terminal with
 * the sidebar closed.
 *
 * Safety:
 * - Feature gated by `settings.autoCloseAfterMerge` (default off).
 * - Only acts on PR cache entries whose `fetchedAt >= startedAt`, i.e. merges
 *   observed by a live fetch in the current session. Entries hydrated from
 *   the on-disk GitHub cache (see `initGitHubCache`) carry their original
 *   pre-launch timestamps, so a user who deliberately kept a post-merge
 *   worktree around on launch N doesn't lose it on launch N+1. Worktrees
 *   whose cached PR is already merged at hydrate time are still recorded in
 *   `handled` so the next live refresh (which *will* bump `fetchedAt`) also
 *   doesn't retroactively delete them.
 * - `handled` prevents re-firing during the async delete window where the
 *   merged-PR cache entry and the worktree still coexist.
 * - Uses `runWorktreeDeleteWithToast` (non-forced), so uncommitted changes
 *   surface as a recoverable toast rather than being wiped silently.
 */
export function attachAutoCloseAfterMergeController(store: AppStoreApi): () => void {
  const handled = new Set<string>()
  const startedAt = Date.now()
  let prevSettings: AppState['settings'] | undefined
  let prevWorktreesByRepo: AppState['worktreesByRepo'] | undefined
  let prevRepos: AppState['repos'] | undefined
  let prevPrCache: AppState['prCache'] | undefined

  const syncAutoClose = (): void => {
    const state = store.getState()

    // Why: Zustand's subscriber fires on every state change (typing in text
    // inputs, terminal updates, etc.), but this controller only depends on
    // four slices. Short-circuit the hot path with reference-equality checks
    // so unrelated updates don't walk every worktree on every keystroke.
    if (
      state.settings === prevSettings &&
      state.worktreesByRepo === prevWorktreesByRepo &&
      state.repos === prevRepos &&
      state.prCache === prevPrCache
    ) {
      return
    }
    prevSettings = state.settings
    prevWorktreesByRepo = state.worktreesByRepo
    prevRepos = state.repos
    prevPrCache = state.prCache

    const autoClose = state.settings?.autoCloseAfterMerge ?? false

    const liveIds = new Set<string>()
    for (const worktrees of Object.values(state.worktreesByRepo)) {
      for (const wt of worktrees) {
        liveIds.add(wt.id)

        // Why: main worktrees back the repo itself — deleting them would
        // wipe the shared checkout for every linked worktree. Auto-close
        // is for throwaway per-PR workspaces only.
        if (wt.isMainWorktree || wt.isBare) {
          continue
        }
        const repo = state.repos.find((r) => r.id === wt.repoId)
        if (!repo) {
          continue
        }
        const branch = branchName(wt.branch)
        if (!branch) {
          continue
        }

        const prEntry = state.prCache[`${repo.path}::${branch}`]
        if (!prEntry?.data || prEntry.data.state !== 'merged') {
          continue
        }

        if (handled.has(wt.id)) {
          continue
        }

        const isLiveObservation = prEntry.fetchedAt >= startedAt
        if (!isLiveObservation) {
          // Persisted-from-disk merge — mark as already-handled so we never
          // retroactively delete a worktree the user chose to keep around,
          // but do so even when the feature is off so a later toggle doesn't
          // suddenly sweep the backlog either.
          handled.add(wt.id)
          continue
        }

        if (!autoClose) {
          // Why: mirror the persisted-from-disk branch's backlog-protection
          // rationale. If the PR merged live-in-session while the setting was
          // off, the user implicitly chose to keep the worktree. Recording it
          // in `handled` ensures a later toggle-on doesn't sweep the backlog
          // and silently delete already-merged worktrees — matching the
          // docstring's promise that toggling doesn't retroactively act.
          handled.add(wt.id)
          continue
        }

        // Why: mark handled *before* the async delete resolves. If the delete
        // fails (e.g. uncommitted changes), we intentionally do NOT retry on
        // every subsequent state change — that would spam duplicate toasts
        // indefinitely. The Force Delete action in the error toast is the
        // user's explicit, opt-in retry path.
        handled.add(wt.id)
        runWorktreeDeleteWithToast(wt.id, wt.displayName)
      }
    }

    // Why: ids are path-scoped, but deleting and recreating a worktree at
    // the same path would otherwise be silently skipped by this guard.
    for (const id of Array.from(handled)) {
      if (!liveIds.has(id)) {
        handled.delete(id)
      }
    }
  }

  const unsubscribe = store.subscribe(syncAutoClose)
  syncAutoClose()

  return () => {
    unsubscribe()
    handled.clear()
  }
}

export function attachAppAutoCloseAfterMergeController(): () => void {
  return attachAutoCloseAfterMergeController(useAppStore)
}
