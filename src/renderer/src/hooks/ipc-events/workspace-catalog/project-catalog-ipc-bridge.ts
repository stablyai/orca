import { applyLocalWorktreeMetadataSet } from './worktree-metadata-set-events'
import { applyWorktreeHeadIdentities } from '../../../store/slices/worktrees/listing/worktree-head-identity-apply'
import type { WorktreeChangeRefreshQueue } from './worktree-change-refresh-queue'
import { useAppStore } from '../../../store/index'
import { adoptFromEndpoint } from '../../../store/host-catalog/endpoint-catalog-adoption'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { refreshBotHost } from '@/lib/bot-catalog'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { patchDetectedWorktreeHeadIdentities } from '@/store/slices/worktrees/listing/detected-worktree-head-identity'

export function registerProjectCatalogIpcBridge(
  unsubs: (() => void)[],
  worktreeChangeRefreshQueue: WorktreeChangeRefreshQueue,
  isRuntimeEnvironmentActive: () => boolean,
  remountTerminalTabsAwaitingHostHydration: () => void
): void {
  unsubs.push(
    window.api.repos.onChanged(() => {
      // This app's own catalog changed, so only its own bots re-read, whichever runtime is active.
      void refreshBotHost(LOCAL_EXECUTION_HOST_ID)
      const state = useAppStore.getState()
      if (isRuntimeEnvironmentActive()) {
        // Why: the all-host sidebar shows local repos even under a runtime; refresh the local slice, keep runtime slices.
        void (async () => {
          const localOwner = { runtimeEnvironmentId: null }
          await state.fetchRepos(localOwner)
          await state.fetchProjectGroups(localOwner)
          await state.fetchFolderWorkspaces(localOwner)
          await state.fetchWorktreeLineage({ forceLocalOwner: true })
          remountTerminalTabsAwaitingHostHydration()
        })()
        return
      }
      // Why: this event is this app's own catalog changing, whichever host is the default.
      const localOwner = { runtimeEnvironmentId: null }
      void state.fetchProjectGroups(localOwner)
      // A folder workspace's bot link changes with this event only, as on a paired server's.
      void state
        .fetchFolderWorkspaces(localOwner)
        .then(() => state.fetchWorktreeLineage({ forceLocalOwner: true }))
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

  if (window.api.worktrees.onMetadataSet) {
    unsubs.push(window.api.worktrees.onMetadataSet(applyLocalWorktreeMetadataSet))
  }

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
        useAppStore.setState(
          (s) => patchDetectedWorktreeHeadIdentities(s, data.repoId, data.identities) ?? s
        )
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
        checkoutProgress: data.checkout ?? undefined,
        ...(data.worktreeId ? { worktreeId: data.worktreeId } : {})
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
