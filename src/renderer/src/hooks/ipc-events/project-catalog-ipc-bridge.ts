import { applyWorktreeHeadIdentities } from '../worktree-head-identity-apply'
import type { WorktreeChangeRefreshQueue } from '../worktree-change-refresh-queue'
import { useAppStore } from '../../store'

export function registerProjectCatalogIpcBridge(
  unsubs: (() => void)[],
  worktreeChangeRefreshQueue: WorktreeChangeRefreshQueue,
  isRuntimeEnvironmentActive: () => boolean,
  remountTerminalTabsAwaitingHostHydration: () => void
): void {
  unsubs.push(
    window.api.repos.onChanged(() => {
      const state = useAppStore.getState()
      if (isRuntimeEnvironmentActive()) {
        // Why: the all-host sidebar shows local repos even under a runtime; refresh the local slice, keep runtime slices.
        void (async () => {
          const localOwner = { runtimeEnvironmentId: null }
          await state.fetchRepos(localOwner)
          await state.fetchProjectGroups(localOwner)
          await state.fetchFolderWorkspaces(localOwner)
          remountTerminalTabsAwaitingHostHydration()
        })()
        return
      }
      void state.fetchProjectGroups()
      void state.fetchFolderWorkspaces()
      void state.fetchRepos().then(remountTerminalTabsAwaitingHostHydration)
    })
  )

  unsubs.push(
    window.api.worktrees.onChanged(
      async (data: {
        repoId: string
        renamed?: { oldWorktreeId: string; newWorktreeId: string }
      }) => {
        // Why: preserve this event's local origin across queue delays and runtime
        // focus changes; otherwise an unbound repo can refresh from the wrong host.
        // A folder rename changes the worktree id; handleWorktreesChanged re-keys
        // state and shields it from the deletion diff.
        worktreeChangeRefreshQueue.enqueue({
          ...data,
          forceLocalOwner: true
        })
      }
    )
  )

  if (window.api.worktrees.onHeadIdentitiesChanged) {
    unsubs.push(
      window.api.worktrees.onHeadIdentitiesChanged((data) => {
        if (isRuntimeEnvironmentActive()) {
          // Why: local worktree events carry local repo ids; the local-pinned list
          // refresh (onChanged) covers local rows while a runtime is active.
          return
        }
        const state = useAppStore.getState()
        applyWorktreeHeadIdentities(data, {
          getWorktreesForRepo: (repoId) => state.worktreesByRepo[repoId],
          updateWorktreeGitIdentity: state.updateWorktreeGitIdentity
        })
      })
    )
  }

  unsubs.push(
    window.api.worktrees.onBaseStatus((event) => {
      if (isRuntimeEnvironmentActive()) {
        return
      }
      useAppStore.getState().updateWorktreeBaseStatus(event)
    })
  )

  unsubs.push(
    window.api.worktrees.onRemoteBranchConflict((event) => {
      if (isRuntimeEnvironmentActive()) {
        return
      }
      useAppStore.getState().updateWorktreeRemoteBranchConflict(event)
    })
  )

  // Why: route main's two-phase creation progress to each pending entry by correlation id (?. guards stale preload).
  unsubs.push(
    window.api.worktrees.onCreateProgress?.((data) => {
      if (!data.creationId) {
        return
      }
      useAppStore.getState().updatePendingWorktreeCreation(data.creationId, { phase: data.phase })
    }) ?? (() => {})
  )

  if (window.api.gh?.onPRRefreshEvent) {
    unsubs.push(
      window.api.gh.onPRRefreshEvent((event) => {
        useAppStore.getState().applyGitHubPRRefreshEvent(event)
      })
    )
  }
}
