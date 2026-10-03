import type { ExecutionHostId } from '../../../../shared/execution-host'
import { refreshRuntimeProjectWorktreesAndLineage } from '@/hooks/runtime-project-refresh-scheduler'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '../../store'

export async function connectRuntimeEnvironmentAndRecordStatus(
  environmentId: string,
  timeoutMs: number
): Promise<boolean> {
  const setStatus = useAppStore.getState().setRuntimeEnvironmentStatus
  try {
    const response = await window.api.runtimeEnvironments.connect({
      selector: environmentId,
      timeoutMs
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(response)
    setStatus(environmentId, { status, checkedAt: Date.now() })
    return true
  } catch {
    setStatus(environmentId, { status: null, checkedAt: Date.now() })
    return false
  }
}

export async function connectRuntimeHostForNavigation(args: {
  environmentId: string
  refreshStatus: (environmentId: string, timeoutMs: number) => Promise<boolean>
  fetchRepos: (environmentId: string) => Promise<{ id: string }[]>
  fetchWorktrees: (
    repoId: string,
    options: { executionHostId: ExecutionHostId; suppressRemoteLineageRefresh: true }
  ) => Promise<unknown>
  fetchLineage: (options: { executionHostId: ExecutionHostId }) => Promise<unknown>
}): Promise<boolean> {
  if (!(await args.refreshStatus(args.environmentId, 5_000))) {
    return false
  }
  const repos = await args.fetchRepos(args.environmentId)
  await refreshRuntimeProjectWorktreesAndLineage(
    args.environmentId,
    repos,
    args.fetchWorktrees,
    args.fetchLineage
  )
  return true
}
