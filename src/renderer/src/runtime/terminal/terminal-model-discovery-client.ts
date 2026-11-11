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
