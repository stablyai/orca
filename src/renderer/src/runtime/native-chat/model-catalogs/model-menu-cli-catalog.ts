import { getAgentModelProbeSpec } from '../../../../../shared/agent-model-probe-spec'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { TERMINAL_EXECUTION_CONTEXT_UNRESOLVED } from '../../../../../shared/terminal/effective-terminal-execution-context'
import { ModelMenuContextUnresolvedError } from './host-model-menu-catalog'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import type {
  RuntimeDiscoverCommitMessageModelsResult,
  RuntimeGitContext
} from '@/runtime/source-control/git/runtime-git-client-context'
import { discoverRuntimeTerminalModels } from './terminal-model-discovery-client'
import type { HostModelMenuScope } from './host-model-menu-catalog'

export function cliModelCatalogAnswer(
  agent: string,
  result: RuntimeDiscoverCommitMessageModelsResult
): AgentSessionModelCatalogResult | undefined {
  if (
    !result.success ||
    result.catalogOrigin === 'spec' ||
    (!result.catalogOrigin && !result.models.length)
  ) {
    return undefined
  }
  const fallback = isTuiAgent(agent) ? getAgentModelProbeSpec(agent) : undefined
  if (
    !result.catalogOrigin &&
    fallback &&
    result.defaultModelId === fallback.defaultModelId &&
    result.models.length === fallback.models.length
  ) {
    const fallbackIds = new Set(fallback.models.map(({ id }) => id))
    if (result.models.every(({ id }) => fallbackIds.has(id))) {
      return undefined
    }
  }
  return {
    origin: 'probe',
    // This transport has no catalog timestamp; identical listings retain identical values.
    fetchedAt: 0,
    listingNamesConfiguredModel: false,
    modelsDifferByWorkspace: true,
    models: result.models.map(({ id, label }) => ({ id, label, isDefault: false, efforts: [] }))
  }
}

export function cliModelMenuScope(
  context: RuntimeGitContext,
  agent: string,
  invocation: string,
  runtime?: string
): HostModelMenuScope {
  return {
    target: context.target,
    agent,
    ...(context.worktreeId ? { worktree: `id:${context.worktreeId}` } : {}),
    sourceKey: JSON.stringify(['cli', invocation.trim(), runtime]),
    request: async () => {
      // The existing remote operation requires a workspace; its helper otherwise falls through to local IPC.
      if (context.target.kind === 'environment' && !context.worktreeId) {
        return undefined
      }
      const result = await discoverRuntimeTerminalModels({ ...context, prefs: undefined }, agent)
      if (!result.success && result.error === TERMINAL_EXECUTION_CONTEXT_UNRESOLVED) {
        throw new ModelMenuContextUnresolvedError(result.error)
      }
      return cliModelCatalogAnswer(agent, result)
    }
  }
}
