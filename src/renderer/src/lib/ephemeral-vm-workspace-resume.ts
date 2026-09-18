import type { EphemeralVmRuntimeRecord } from '../../../shared/ephemeral-vm-runtimes'
import { useAppStore } from '@/store'
import { RuntimeRepoCatalogSupersededError } from '@/store/repos/repo-catalog-fencing'
import { connectRuntimeEnvironmentAndRecordStatus } from '@/components/status-bar/runtime-environment-explicit-connect'
import { refreshRuntimeProjectWorktreesAndLineage } from '@/hooks/runtime-project-refresh-scheduler'

export async function resumeEphemeralVmWorkspace(workspaceId: string): Promise<void> {
  const runtime = await window.api.ephemeralVm.resumeWorkspace({ workspaceId })
  if (!runtime) {
    throw new Error('Cloud VM workspace is no longer registered.')
  }
  await reconnectEphemeralVmWorkspace(runtime)
}

export async function reconnectEphemeralVmWorkspace(
  runtime: EphemeralVmRuntimeRecord
): Promise<void> {
  if (!runtime.runtimeEnvironmentId) {
    return
  }
  const environmentId = runtime.runtimeEnvironmentId
  const store = useAppStore.getState()
  store.setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
  if (!(await connectRuntimeEnvironmentAndRecordStatus(environmentId, 30_000))) {
    throw new Error('Could not reconnect to the resumed Cloud VM.')
  }
  // A sleeping host has no catalog at startup; reconnect must restore its sidebar rows.
  const repos = await fetchReconnectedRuntimeRepos(environmentId)
  if (repos.length === 0) {
    throw new Error('Could not load the resumed Cloud VM project. Retry reconnecting.')
  }
  await refreshRuntimeProjectWorktreesAndLineage(
    environmentId,
    repos,
    (repoId, options) => useAppStore.getState().fetchWorktrees(repoId, options),
    (options) => useAppStore.getState().fetchWorktreeLineage(options)
  )
}

async function fetchReconnectedRuntimeRepos(environmentId: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await useAppStore.getState().fetchRuntimeEnvironmentRepos(environmentId, {
        rejectSuperseded: true
      })
    } catch (error) {
      // A reconnect also schedules a background refresh, which can retire this request.
      if (!(error instanceof RuntimeRepoCatalogSupersededError) || attempt >= 2) {
        throw error
      }
    }
  }
}
