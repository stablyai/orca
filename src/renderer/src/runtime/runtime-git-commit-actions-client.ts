import type {
  GitCommitAction,
  GitCommitActionResult
} from '../../../shared/git/commands/git-commit-action'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

export async function cherryPickRuntimeGit(
  context: RuntimeGitContext,
  commitId: string
): Promise<GitCommitActionResult> {
  if (context.target.kind === 'local' || !context.worktreeId) {
    return window.api.git.cherryPick({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      commitId
    })
  }
  return callRuntimeRpc(
    context.target,
    'git.cherryPick',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), commitId },
    { timeoutMs: 30_000 }
  )
}

export async function revertRuntimeGit(
  context: RuntimeGitContext,
  commitId: string
): Promise<GitCommitActionResult> {
  if (context.target.kind === 'local' || !context.worktreeId) {
    return window.api.git.revert({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      commitId
    })
  }
  return callRuntimeRpc(
    context.target,
    'git.revert',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), commitId },
    { timeoutMs: 30_000 }
  )
}

export async function sequencerAbortRuntimeGit(
  context: RuntimeGitContext,
  operation: GitCommitAction
): Promise<void> {
  if (context.target.kind === 'local' || !context.worktreeId) {
    return window.api.git.sequencerAbort({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      operation
    })
  }
  await callRuntimeRpc(
    context.target,
    'git.sequencerAbort',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), operation },
    { timeoutMs: 30_000 }
  )
}

export async function sequencerContinueRuntimeGit(
  context: RuntimeGitContext,
  operation: GitCommitAction
): Promise<void> {
  if (context.target.kind === 'local' || !context.worktreeId) {
    return window.api.git.sequencerContinue({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      operation
    })
  }
  await callRuntimeRpc(
    context.target,
    'git.sequencerContinue',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), operation },
    { timeoutMs: 30_000 }
  )
}
