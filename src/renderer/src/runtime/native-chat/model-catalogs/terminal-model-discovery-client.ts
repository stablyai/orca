import { translate } from '@/i18n/i18n'
import type {
  RuntimeGitContext,
  RuntimeDiscoverCommitMessageModelsResult
} from '@/runtime/source-control/git/runtime-git-client-context'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import { TEXT_GENERATION_CLIENT_TIMEOUT_MS } from '../../../../../shared/text-generation-client-timeout'

export async function discoverRuntimeTerminalModels(
  context: RuntimeGitContext,
  agentId: string
): Promise<RuntimeDiscoverCommitMessageModelsResult> {
  const worktree = context.worktreeId
    ? toRuntimeWorktreeSelector(context.worktreeId)
    : context.worktreePath
      ? `path:${context.worktreePath}`
      : undefined
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
    return window.api.git.discoverTerminalModels({ agentId, ...(worktree ? { worktree } : {}) })
  }
  if (!context.worktreeId) {
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
    { worktree, agentId },
    {
      timeoutMs: TEXT_GENERATION_CLIENT_TIMEOUT_MS
    }
  )
}
