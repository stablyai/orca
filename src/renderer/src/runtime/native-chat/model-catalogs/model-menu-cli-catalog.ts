import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import type {
  RuntimeDiscoverCommitMessageModelsResult,
  RuntimeGitContext
} from '@/runtime/source-control/git/runtime-git-client-context'
import { discoverRuntimeCommitMessageModels } from '@/runtime/source-control/git/runtime-git-generation-client'
import type { HostModelMenuScope } from './host-model-menu-catalog'

export function cliModelCatalogAnswer(
  result: RuntimeDiscoverCommitMessageModelsResult
): AgentSessionModelCatalogResult | undefined {
  if (
    !result.success ||
    result.catalogOrigin === 'spec' ||
    (!result.catalogOrigin && !result.models.length) ||
    result.models.some(({ id, label }) => id === 'default' && label === 'Config default')
  ) {
    return undefined
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
      return cliModelCatalogAnswer(
        await discoverRuntimeCommitMessageModels({ ...context, prefs: undefined }, agent)
      )
    }
  }
}
