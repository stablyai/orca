import { structuredAgentSessionOwnerInputs } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { AppState } from '@/store/types'
import {
  getLocalProjectExecutionRuntimeContext,
  getLocalRepoProjectExecutionRuntimeContext
} from '@/runtime/hosts/preflight/local-preflight-context'
import { getCachedLocalProjectRuntimeWslContext } from '@/runtime/hosts/preflight/local-preflight-context-cache'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { lastVerifiedRuntimeStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { groupAntigravityModelEfforts } from '../../../../shared/agent-session/options/antigravity-model-efforts'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import { translate } from '@/i18n/i18n'
import type {
  RuntimeGitContext,
  RuntimeDiscoverCommitMessageModelsResult
} from '@/runtime/source-control/git/runtime-git-client-context'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '../rpc/targets/runtime-worktree-selector'
import { TEXT_GENERATION_CLIENT_TIMEOUT_MS } from '../../../../shared/text-generation-client-timeout'
import type { TerminalModelDiscoveryParams } from '../../../../shared/rpc-contract/agent-model-discovery-params'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type TerminalModelDiscoveryDescriptor = {
  runtime: RuntimeGitContext
  launch: Omit<TerminalModelDiscoveryParams, 'agentId'>
  key: string
}

export function terminalModelDiscoveryRuntimeIdentity(
  state: AppState,
  runtime: RuntimeGitContext | undefined
): string | undefined {
  if (runtime?.target.kind !== 'environment') {
    return undefined
  }
  const id = runtime.target.environmentId
  return JSON.stringify([
    getRuntimeEnvironmentRevision(id),
    lastVerifiedRuntimeStatus(state.runtimeStatusByEnvironmentId.get(id))?.runtimeId
  ])
}

/** One projection owns the request and every execution dependency that can invalidate it. */
export function terminalModelDiscoveryDescriptor(
  state: AppState,
  runtime: RuntimeGitContext,
  launch: Omit<TerminalModelDiscoveryParams, 'agentId'> = {}
): TerminalModelDiscoveryDescriptor {
  const local = runtime.target.kind === 'local' && !runtime.connectionId
  const settings = local ? state.settings : undefined
  const wslContext = getCachedLocalProjectRuntimeWslContext()
  const projectRuntime = local
    ? runtime.worktreeId
      ? getLocalProjectExecutionRuntimeContext(state, runtime.worktreeId, undefined, wslContext)
      : typeof launch.repo === 'string'
        ? getLocalRepoProjectExecutionRuntimeContext(state, launch.repo, undefined, wslContext)
        : undefined
    : undefined
  return {
    runtime,
    launch,
    key: JSON.stringify([
      runtime.target,
      runtime.worktreeId,
      runtime.worktreePath,
      runtime.connectionId,
      launch,
      terminalModelDiscoveryRuntimeIdentity(state, runtime),
      local
        ? [
            settings?.agentCmdOverrides?.antigravity,
            settings?.agentDefaultEnv?.antigravity,
            settings?.terminalWindowsShell,
            settings?.terminalWindowsWslDistro,
            settings?.localWindowsRuntimeDefault,
            projectRuntime
          ]
        : undefined
    ])
  }
}

/** Compare context roots before resolving projects; status updates never scan terminal contexts. */
export function terminalModelDiscoveryOwnerInputs(state: AppState): unknown[] {
  return [state.projects, ...structuredAgentSessionOwnerInputs(state)]
}

export function createTerminalModelDiscoveryKeySelector(
  read: (state: AppState) => TerminalModelDiscoveryDescriptor | null
) {
  let inputs: unknown[] | undefined
  let current: TerminalModelDiscoveryDescriptor | null = null
  let identity: string | undefined
  return (state: AppState) => {
    const next = terminalModelDiscoveryOwnerInputs(state)
    if (
      !inputs ||
      next.some((value, index) => value !== inputs![index]) ||
      terminalModelDiscoveryRuntimeIdentity(state, current?.runtime) !== identity
    ) {
      inputs = next
      current = read(state)
      identity = terminalModelDiscoveryRuntimeIdentity(state, current?.runtime)
    }
    return current?.key
  }
}

export async function discoverRuntimeTerminalModels(
  context: RuntimeGitContext,
  agentId: string,
  launch?: Omit<TerminalModelDiscoveryParams, 'agentId'>
): Promise<RuntimeDiscoverCommitMessageModelsResult> {
  const worktree = context.worktreeId
    ? toRuntimeWorktreeSelector(context.worktreeId)
    : context.worktreePath
      ? `path:${context.worktreePath}`
      : undefined
  const params = { agentId, ...(worktree ? { worktree } : {}), ...launch }
  if (context.target.kind === 'local') {
    if (context.connectionId) {
      return {
        success: false,
        error: translate(
          'agents.terminalModels.connectionUnavailable',
          'Terminal model discovery is unavailable on this connection.'
        )
      }
    }
    return window.api.git.discoverTerminalModels(params)
  }
  if (!params.worktree && !params.repo && !params.folder && !params.cwd) {
    return {
      success: false,
      error: translate(
        'agents.terminalModels.workspaceRequired',
        'Terminal model discovery requires a workspace on this host.'
      )
    }
  }
  return callRuntimeRpc<RuntimeDiscoverCommitMessageModelsResult>(
    context.target,
    'agent.discoverTerminalModels',
    params,
    {
      timeoutMs: TEXT_GENERATION_CLIENT_TIMEOUT_MS
    }
  )
}

export async function readAntigravityTerminalCatalog(
  context: RuntimeGitContext,
  launch?: Omit<TerminalModelDiscoveryParams, 'agentId'>
): Promise<AgentSessionModelCatalogResult> {
  const result = await discoverRuntimeTerminalModels(context, 'antigravity', launch)
  return antigravityTerminalCatalog(result)
}

export async function readAntigravityHostTerminalCatalog(
  target: RuntimeClientTarget
): Promise<AgentSessionModelCatalogResult> {
  const params = { agentId: 'antigravity' }
  const result =
    target.kind === 'local'
      ? await window.api.git.discoverTerminalModels(params)
      : await callRuntimeRpc<RuntimeDiscoverCommitMessageModelsResult>(
          target,
          'agent.discoverTerminalModels',
          params,
          { timeoutMs: TEXT_GENERATION_CLIENT_TIMEOUT_MS }
        )
  return antigravityTerminalCatalog(result)
}

function antigravityTerminalCatalog(
  result: RuntimeDiscoverCommitMessageModelsResult
): AgentSessionModelCatalogResult {
  return result.success && result.catalogOrigin === 'probe' && result.models.length
    ? {
        origin: 'probe',
        fetchedAt: Date.now(),
        models: groupAntigravityModelEfforts(result.models)
      }
    : { origin: 'unknown' }
}
