import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { refreshRuntimeProjectWorktreesAndLineage } from '@/hooks/runtime-project-refresh-scheduler'
import { translate } from '@/i18n/i18n'
import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import { useAppStore } from '../../store'

export async function connectRuntimeEnvironmentAndRecordStatus(
  environmentId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  const setStatus = useAppStore.getState().setRuntimeEnvironmentStatus
  try {
    const response = await window.api.runtimeEnvironments.connect({
      selector: environmentId,
      timeoutMs
    })
    if (signal?.aborted) {
      return false
    }
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(response)
    setStatus(environmentId, { status, checkedAt: Date.now() })
    return true
  } catch {
    if (signal?.aborted) {
      return false
    }
    setStatus(environmentId, { status: null, checkedAt: Date.now() })
    return false
  }
}

export async function connectRuntimeHostForNavigation(args: {
  environmentId: string
  signal?: AbortSignal
  refreshStatus: (environmentId: string, timeoutMs: number) => Promise<boolean>
  fetchRepos: (environmentId: string) => Promise<{ id: string }[]>
  fetchWorktrees: (
    repoId: string,
    options: { executionHostId: ExecutionHostId; suppressRemoteLineageRefresh: true }
  ) => Promise<unknown>
  fetchLineage: (options: { executionHostId: ExecutionHostId }) => Promise<unknown>
}): Promise<boolean> {
  try {
    if (!(await args.refreshStatus(args.environmentId, 5_000)) || args.signal?.aborted) {
      return false
    }
    const repos = await args.fetchRepos(args.environmentId)
    if (args.signal?.aborted) {
      return false
    }
    await refreshRuntimeProjectWorktreesAndLineage(
      args.environmentId,
      repos,
      async (repoId, options) => {
        if (!args.signal?.aborted) {
          return args.fetchWorktrees(repoId, options)
        }
        return undefined
      },
      async (options) => {
        if (!args.signal?.aborted) {
          return args.fetchLineage(options)
        }
        return undefined
      }
    )
    return !args.signal?.aborted
  } catch (error) {
    if (args.signal?.aborted) {
      return false
    }
    throw error
  }
}

/**
 * The status bar's Connect for a paired host; also the chat's Reconnect when its host is offline
 * and a stopped WSL host’s Start, which passes its own failure message.
 */
export async function connectRuntimeHostAndReloadProjects(
  environmentId: string,
  failureMessage?: string,
  signal?: AbortSignal
): Promise<boolean> {
  const store = useAppStore.getState()
  const reachable = await connectRuntimeHostForNavigation({
    environmentId,
    signal,
    refreshStatus: (id, timeoutMs) =>
      connectRuntimeEnvironmentAndRecordStatus(id, timeoutMs, signal),
    fetchRepos: store.fetchRuntimeEnvironmentRepos,
    fetchWorktrees: store.fetchWorktrees,
    fetchLineage: store.fetchWorktreeLineage
  })
  if (!reachable && !signal?.aborted) {
    toast.error(
      failureMessage ??
        translate(
          'auto.components.status.bar.SshStatusSegment.runtime_connect_unavailable',
          'Remote host is not reachable'
        )
    )
  }
  return reachable
}
