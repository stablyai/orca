import { refreshBotHost } from '@/lib/bot-host-refresh'
import { refreshRuntimeEnvironmentSshTargetMetadata } from '@/runtime/hosts/ssh/runtime-environment-ssh-state'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { useAppStore } from '../../../store'
import {
  createRuntimeProjectRefreshScheduler,
  refreshRuntimeProjectWorktreesAndLineage,
  type RuntimeProjectRefreshScheduler
} from './runtime-project-refresh-scheduler'

/** Re-reads a paired server's projects, coalesced per server, on its project events, its connecting and its stream's replay. */
export function createRuntimeProjectCatalogRefreshScheduler(): RuntimeProjectRefreshScheduler {
  return createRuntimeProjectRefreshScheduler({
    refresh: async (environmentId) => {
      // Why: project events can reveal target CRUD, but known target states already arrive by push.
      void refreshRuntimeEnvironmentSshTargetMetadata(environmentId).catch(() => {})
      // Why: hosts without workspaceViewChanged still refresh their columns here.
      void useAppStore.getState().fetchHostWorkspaceStatuses(environmentId)
      // A bot's link to its home changes with this event, as for this app's own catalog; unlisted hosts skip it.
      void refreshBotHost(toRuntimeExecutionHostId(environmentId))
      const repos = await useAppStore.getState().fetchRuntimeEnvironmentRepos(environmentId)
      // Group/folder edits share reposChanged; refresh groups before folders to resolve their owners.
      const runtimeOwner = { runtimeEnvironmentId: environmentId }
      // Refresh catalogs/worktrees independently so two catalog RPC timeouts cannot delay lineage convergence.
      await Promise.all([
        (async () => {
          await useAppStore.getState().fetchProjectGroups(runtimeOwner)
          await useAppStore.getState().fetchFolderWorkspaces(runtimeOwner)
        })(),
        refreshRuntimeProjectWorktreesAndLineage(
          environmentId,
          repos,
          (repoId, options) => useAppStore.getState().fetchWorktrees(repoId, options),
          (options) => useAppStore.getState().fetchWorktreeLineage(options)
        )
      ])
    },
    onError: (error) => {
      console.error('Failed to refresh runtime projects:', error)
    }
  })
}
