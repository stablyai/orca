import { useAppStore } from '../../store/index'
import { refreshRuntimeEnvironmentSshTargetMetadata } from '@/runtime/hosts/ssh/runtime-environment-ssh-state'
import {
  createRuntimeProjectRefreshScheduler,
  refreshRuntimeProjectWorktreesAndLineage
} from '../runtime-project-refresh-scheduler'

export function createClientEventProjectRefreshScheduler() {
  return createRuntimeProjectRefreshScheduler({
    refresh: async (environmentId) => {
      // Why: project events can reveal target CRUD, but known target states already arrive by push.
      void refreshRuntimeEnvironmentSshTargetMetadata(environmentId).catch(() => {})
      // Why: hosts without workspaceViewChanged still refresh their columns here.
      void useAppStore.getState().fetchHostWorkspaceStatuses(environmentId)
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
