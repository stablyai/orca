import { applyWorktreeHeadIdentities } from '../worktree-head-identity-apply'
import type { WorktreeChangeRefreshQueue } from '../worktree-change-refresh-queue'
import { useAppStore } from '../../store'
import { adoptFromEndpoint } from '../../store/adopt-from-endpoint'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

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
      // Why: this event is this app's own catalog changing, whichever host is the default.
      const localOwner = { runtimeEnvironmentId: null }
      void state.fetchProjectGroups(localOwner)
      void state.fetchFolderWorkspaces(localOwner)
      void state.fetchRepos(localOwner).then(remountTerminalTabsAwaitingHostHydration)
    })
  )

  unsubs.push(
    window.api.worktrees.onChanged(
      async (data: {
        repoId: string
        renamed?: { oldWorktreeId: string; newWorktreeId: string }
      }) => {
        // Preserve local event origin through queue/focus changes; rekey folder renames before deletion diff so moved state survives.
        worktreeChangeRefreshQueue.enqueue(
          adoptFromEndpoint({ kind: 'local' }, { kind: 'worktreeEvent', row: data })
        )
      }
    )
  )

  if (window.api.worktrees.onHeadIdentitiesChanged) {
    unsubs.push(
      window.api.worktrees.onHeadIdentitiesChanged((data) => {
        if (isRuntimeEnvironmentActive()) {
          // Local CLI events name local repos; use the pinned local refresh while a runtime is active.
          return
        }
        const state = useAppStore.getState()
        applyWorktreeHeadIdentities(data, {
          getWorktreesForRepo: (repoId) => selectWorktreesByRepo(state)[repoId],
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
      // Why: every event without a live meter (a phase change, or null when git finished) clears it.
      useAppStore.getState().updatePendingWorktreeCreation(data.creationId, {
        phase: data.phase,
        checkoutProgress: data.checkout ?? undefined
      })
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
