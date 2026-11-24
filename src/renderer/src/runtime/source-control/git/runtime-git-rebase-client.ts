import type {
  ContinueRebaseAction,
  ContinueRebaseRequest,
  ContinueRebaseResult
} from '../../../../../shared/git/status/git-status-types'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'

export async function continueRuntimeGitRebase(
  context: RuntimeGitContext,
  action: ContinueRebaseAction,
  request: ContinueRebaseRequest = {}
): Promise<ContinueRebaseResult> {
  const { expected } = request
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.continueRebase({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      action,
      expected
    })
  }
  try {
    return await callRuntimeRpc<ContinueRebaseResult>(
      target,
      'git.continueRebase',
      {
        worktree: toRuntimeWorktreeSelector(context.worktreeId),
        action,
        ...(expected ? { expected } : {})
      },
      // Each step can run hooks and rewrite many commits; a timeout leaves the outcome unknown.
      { timeoutMs: 120_000, ...(action === 'inspect' ? { background: true, wake: false } : {}) }
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return {
        outcome: 'failed',
        message: translate(
          'auto.runtime.runtimeGitSyncClient.continueRebaseNeedsNewerHost',
          'Continuing a rebase needs a newer Orca on this host. Update Orca on that host.'
        )
      }
    }
    throw error
  }
}

/** `unsupported`: an older host without the probe; callers treat it as off and stop asking. */
export async function readRuntimeGitRebaseAutoStash(
  context: RuntimeGitContext
): Promise<boolean | 'unsupported'> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.rebaseAutoStash({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId
    })
  }
  try {
    const result = await callRuntimeRpc<{ autoStash: boolean }>(
      target,
      'git.rebaseAutoStash',
      { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
      { timeoutMs: 15_000, background: true, wake: false }
    )
    return result.autoStash
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return 'unsupported'
    }
    throw error
  }
}
