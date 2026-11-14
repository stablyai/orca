import type {
  GitCommitAction,
  GitCommitActionResult
} from '../../../../../shared/git/commands/git-commit-action'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'

export async function createRuntimeGitBranch(
  context: RuntimeGitContext,
  name: string,
  startPoint: string,
  beforeSend?: () => void
): Promise<GitCommitActionResult> {
  if (context.target.kind === 'local' || !context.worktreeId) {
    beforeSend?.()
    return window.api.git.createBranch({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      name,
      startPoint
    })
  }
  return callRuntimeRpc(
    context.target,
    'git.createBranch',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      name,
      startPoint
    },
    { timeoutMs: 30_000, beforeSend }
  )
}

export async function cherryPickRuntimeGit(
  context: RuntimeGitContext,
  commitId: string,
  beforeSend?: () => void
): Promise<GitCommitActionResult> {
  if (context.target.kind === 'local' || !context.worktreeId) {
    beforeSend?.()
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
    { timeoutMs: 30_000, beforeSend }
  )
}

export async function revertRuntimeGit(
  context: RuntimeGitContext,
  commitId: string,
  beforeSend?: () => void
): Promise<GitCommitActionResult> {
  if (context.target.kind === 'local' || !context.worktreeId) {
    beforeSend?.()
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
    { timeoutMs: 30_000, beforeSend }
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
): Promise<GitCommitActionResult | void> {
  if (context.target.kind === 'local' || !context.worktreeId) {
    return window.api.git.sequencerContinue({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      operation
    })
  }
  const result = await callRuntimeRpc<GitCommitActionResult | { ok: boolean }>(
    context.target,
    'git.sequencerContinue',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), operation },
    { timeoutMs: 30_000 }
  )
  return typeof result === 'object' && result !== null && 'outcome' in result ? result : undefined
}
