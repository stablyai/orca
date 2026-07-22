import type { AppState } from '@/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { Repo, TuiAgent } from '../../../shared/types'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import {
  getLocalProjectExecutionRuntimeContext,
  getLocalRepoProjectExecutionRuntimeContext
} from '@/lib/local-preflight-context'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'

type WorkItemHostAgentStore = Pick<
  AppState,
  'ensureDetectedAgents' | 'ensureRemoteDetectedAgents' | 'ensureRuntimeDetectedAgents'
>

type LocalDetectionTarget = Parameters<AppState['ensureDetectedAgents']>[0]

export function getRuntimeWorkItemLaunchContext(
  state: Pick<AppState, 'runtimeStatusByEnvironmentId'>,
  executionHostId: ExecutionHostId
): { environmentId: string; platform: NodeJS.Platform } | null {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind !== 'runtime') {
    return null
  }
  return {
    environmentId: host.environmentId,
    // Why: runtime status can arrive after host selection; Linux is the portable runtime default until then.
    platform:
      state.runtimeStatusByEnvironmentId.get(host.environmentId)?.status?.hostPlatform ?? 'linux'
  }
}

export function getWorkItemRepoLaunchContext(
  state: AppState,
  repo: Repo,
  executionHostId: ExecutionHostId,
  platformOverride?: NodeJS.Platform
): {
  runtimeEnvironmentId: string | null
  projectRuntime: ReturnType<typeof getLocalRepoProjectExecutionRuntimeContext>
  platform: NodeJS.Platform
} {
  const runtime = getRuntimeWorkItemLaunchContext(state, executionHostId)
  const projectRuntime =
    repo.connectionId || runtime
      ? undefined
      : getLocalRepoProjectExecutionRuntimeContext(state, repo.id, CLIENT_PLATFORM)
  return {
    runtimeEnvironmentId: runtime?.environmentId ?? null,
    projectRuntime,
    platform:
      platformOverride ??
      runtime?.platform ??
      resolveSourceControlLaunchPlatform({
        connectionId: repo.connectionId,
        worktreePath: repo.path,
        projectRuntime
      })
  }
}

export function getCreatedWorkItemLaunchPlatform(
  state: AppState,
  options: {
    executionHostId: ExecutionHostId
    connectionId: string | null
    worktreeId: string
    worktreePath: string
    repoProjectRuntime: ReturnType<typeof getLocalRepoProjectExecutionRuntimeContext>
    platformOverride?: NodeJS.Platform
  }
): NodeJS.Platform {
  return (
    options.platformOverride ??
    getRuntimeWorkItemLaunchContext(state, options.executionHostId)?.platform ??
    resolveSourceControlLaunchPlatform({
      connectionId: options.connectionId,
      worktreePath: options.worktreePath,
      projectRuntime: options.connectionId
        ? undefined
        : (getLocalProjectExecutionRuntimeContext(state, options.worktreeId, CLIENT_PLATFORM) ??
          options.repoProjectRuntime)
    })
  )
}

export async function ensureWorkItemHostAgents(
  store: WorkItemHostAgentStore,
  options: {
    runtimeEnvironmentId?: string | null
    connectionId?: string | null
    localTarget?: LocalDetectionTarget
  }
): Promise<TuiAgent[]> {
  // Why: runtime ownership is authoritative even when legacy SSH metadata remains on the repo.
  if (options.runtimeEnvironmentId) {
    return await store.ensureRuntimeDetectedAgents(options.runtimeEnvironmentId)
  }
  if (options.connectionId) {
    return await store.ensureRemoteDetectedAgents(options.connectionId)
  }
  return await store.ensureDetectedAgents(options.localTarget)
}
