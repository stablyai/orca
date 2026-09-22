import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

export async function stageRuntimeGitPath(
  context: RuntimeGitContext,
  filePath: string
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
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

export async function bulkStageRuntimeGitPaths(
  context: RuntimeGitContext,
  filePaths: string[]
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
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

export async function unstageRuntimeGitPath(
  context: RuntimeGitContext,
  filePath: string
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
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
  const target = getActiveRuntimeTarget(context.settings)
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
  const target = getActiveRuntimeTarget(context.settings)
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
  const target = getActiveRuntimeTarget(context.settings)
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
  args: { relativePath: string; line: number }
): Promise<string | null> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.remoteFileUrl({
      worktreePath: resolveLocalWorktreePath(context),
      relativePath: args.relativePath,
      line: args.line,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<string | null>(
    target,
    'git.remoteFileUrl',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      relativePath: args.relativePath,
      line: args.line
    },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitRemoteCommitUrl(
  context: RuntimeGitContext,
  args: { sha: string }
): Promise<string | null> {
  const target = getActiveRuntimeTarget(context.settings)
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
