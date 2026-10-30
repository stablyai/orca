import {
  requireGitStageWorktreeScopeReceipt,
  type GitStageWorktreeScope
} from '../../../shared/git-stage-worktree-scope'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import type { ConflictResolution } from '../../../shared/source-control-entry-actions'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

export async function stageRuntimeGitPath(
  context: RuntimeGitContext,
  filePath: string
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.stage({
      worktreePath: resolveLocalWorktreePath(context),
      filePath,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.stage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePath },
    { timeoutMs: 15_000 }
  )
}

export async function resolveRuntimeGitConflict(
  context: RuntimeGitContext,
  filePath: string,
  resolution: ConflictResolution
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.resolveConflict({
      worktreePath: resolveLocalWorktreePath(context),
      filePath,
      resolution,
      connectionId: context.connectionId
    })
    return
  }
  try {
    await callRuntimeRpc(
      target,
      'git.resolveConflict',
      { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePath, resolution },
      { timeoutMs: 15_000 }
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      throw new Error(
        translate(
          'auto.runtime.runtimeGitWorkingTreeClient.resolveConflictNeedsNewerHost',
          'Resolving conflicts needs a newer Orca on this host. Update Orca on that host.'
        )
      )
    }
    throw error
  }
}

export async function bulkStageRuntimeGitPaths(
  context: RuntimeGitContext,
  filePaths: string[]
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.bulkStage({
      worktreePath: resolveLocalWorktreePath(context),
      filePaths,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.bulkStage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePaths },
    { timeoutMs: 15_000 }
  )
}

/** Stage every change the host sees, for a capped listing that cannot name them all. */
export async function stageRuntimeGitWorktreeScope(
  context: RuntimeGitContext,
  scope: GitStageWorktreeScope
): Promise<void> {
  const target = context.target
  // Why no paths: an older host strips `scope` and stages `filePaths`, so an empty list makes that a no-op.
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.bulkStage({
      worktreePath: resolveLocalWorktreePath(context),
      filePaths: [],
      connectionId: context.connectionId,
      scope
    })
    return
  }
  const reply = await callRuntimeRpc<unknown>(
    target,
    'git.bulkStage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePaths: [], scope },
    { timeoutMs: 15_000 }
  )
  requireGitStageWorktreeScopeReceipt(reply, scope)
}

export async function unstageRuntimeGitPath(
  context: RuntimeGitContext,
  filePath: string
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.unstage({
      worktreePath: resolveLocalWorktreePath(context),
      filePath,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.unstage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePath },
    { timeoutMs: 15_000 }
  )
}

export async function bulkUnstageRuntimeGitPaths(
  context: RuntimeGitContext,
  filePaths: string[]
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.bulkUnstage({
      worktreePath: resolveLocalWorktreePath(context),
      filePaths,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.bulkUnstage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePaths },
    { timeoutMs: 15_000 }
  )
}

export async function bulkDiscardRuntimeGitPaths(
  context: RuntimeGitContext,
  filePaths: string[]
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.bulkDiscard({
      worktreePath: resolveLocalWorktreePath(context),
      filePaths,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.bulkDiscard',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePaths },
    { timeoutMs: 15_000 }
  )
}

export async function discardRuntimeGitPath(
  context: RuntimeGitContext,
  filePath: string
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.discard({
      worktreePath: resolveLocalWorktreePath(context),
      filePath,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.discard',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePath },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitRemoteFileUrl(
  context: RuntimeGitContext,
  args: { relativePath: string; line: number; endLine?: number }
): Promise<string | null> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.remoteFileUrl({
      worktreePath: resolveLocalWorktreePath(context),
      relativePath: args.relativePath,
      line: args.line,
      endLine: args.endLine,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<string | null>(
    target,
    'git.remoteFileUrl',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      relativePath: args.relativePath,
      line: args.line,
      endLine: args.endLine
    },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitRemoteCommitUrl(
  context: RuntimeGitContext,
  args: { sha: string }
): Promise<string | null> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.remoteCommitUrl({
      worktreePath: resolveLocalWorktreePath(context),
      sha: args.sha,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<string | null>(
    target,
    'git.remoteCommitUrl',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), sha: args.sha },
    { timeoutMs: 15_000 }
  )
}
