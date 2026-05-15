/* eslint-disable max-lines -- Why: this module mirrors the git preload API with
runtime-aware routing so source-control callers have one typed boundary instead
of reimplementing local-vs-environment branching per operation. */
import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitPushTarget,
  GitStatusResult,
  GitUpstreamStatus,
  GlobalSettings
} from '../../../shared/types'
import type { GitHistoryOptions, GitHistoryResult } from '../../../shared/git-history'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'

export type RuntimeGenerateCommitMessageResult =
  | { success: true; message: string; agentLabel?: string }
  | { success: false; error: string; canceled?: boolean }

type RuntimeGitSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> &
  Partial<Pick<GlobalSettings, 'commitMessageAi' | 'agentCmdOverrides' | 'enableGitHubAttribution'>>

export type RuntimeGitContext = {
  settings: RuntimeGitSettings | null | undefined
  worktreeId: string | null | undefined
  worktreePath: string
  connectionId?: string
}

function getRuntimeCommitMessageSettings(
  settings: RuntimeGitSettings | null | undefined
): Partial<
  Pick<GlobalSettings, 'commitMessageAi' | 'agentCmdOverrides' | 'enableGitHubAttribution'>
> {
  if (!settings) {
    return {}
  }
  return {
    ...(settings.commitMessageAi !== undefined
      ? { commitMessageAi: settings.commitMessageAi }
      : {}),
    ...(settings.agentCmdOverrides !== undefined
      ? { agentCmdOverrides: settings.agentCmdOverrides }
      : {}),
    ...(settings.enableGitHubAttribution !== undefined
      ? { enableGitHubAttribution: settings.enableGitHubAttribution }
      : {})
  }
}

export function getRuntimeGitScope(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  connectionId: string | undefined
): string | undefined {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment' ? `runtime:${target.environmentId}` : connectionId
}

export async function getRuntimeGitStatus(
  context: RuntimeGitContext,
  options?: { includeIgnored?: boolean }
): Promise<GitStatusResult> {
  const target = getActiveRuntimeTarget(context.settings)
  const includeIgnoredArgs = options?.includeIgnored ? { includeIgnored: true } : {}
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.status({
      worktreePath: context.worktreePath,
      connectionId: context.connectionId,
      ...includeIgnoredArgs
    })
  }
  return callRuntimeRpc<GitStatusResult>(
    target,
    'git.status',
    { worktree: context.worktreeId, ...includeIgnoredArgs },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitHistory(
  context: RuntimeGitContext,
  options: GitHistoryOptions = {}
): Promise<GitHistoryResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.history({
      worktreePath: context.worktreePath,
      connectionId: context.connectionId,
      ...options
    })
  }
  return callRuntimeRpc<GitHistoryResult>(
    target,
    'git.history',
    { worktree: context.worktreeId, ...options },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitConflictOperation(
  context: RuntimeGitContext
): Promise<GitConflictOperation> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.conflictOperation({
      worktreePath: context.worktreePath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitConflictOperation>(
    target,
    'git.conflictOperation',
    { worktree: context.worktreeId },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitDiff(
  context: RuntimeGitContext,
  args: { filePath: string; staged: boolean; compareAgainstHead?: boolean }
): Promise<GitDiffResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.diff({
      worktreePath: context.worktreePath,
      filePath: args.filePath,
      staged: args.staged,
      compareAgainstHead: args.compareAgainstHead,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitDiffResult>(
    target,
    'git.diff',
    { worktree: context.worktreeId, ...args },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitBranchCompare(
  context: RuntimeGitContext,
  baseRef: string
): Promise<GitBranchCompareResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.branchCompare({
      worktreePath: context.worktreePath,
      baseRef,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitBranchCompareResult>(
    target,
    'git.branchCompare',
    { worktree: context.worktreeId, baseRef },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitCommitCompare(
  context: RuntimeGitContext,
  commitId: string
): Promise<GitCommitCompareResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.commitCompare({
      worktreePath: context.worktreePath,
      commitId,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitCommitCompareResult>(
    target,
    'git.commitCompare',
    { worktree: context.worktreeId, commitId },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitUpstreamStatus(
  context: RuntimeGitContext
): Promise<GitUpstreamStatus> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.upstreamStatus({
      worktreePath: context.worktreePath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitUpstreamStatus>(
    target,
    'git.upstreamStatus',
    { worktree: context.worktreeId },
    { timeoutMs: 15_000 }
  )
}

export async function fetchRuntimeGit(context: RuntimeGitContext): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.fetch({
      worktreePath: context.worktreePath,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(target, 'git.fetch', { worktree: context.worktreeId }, { timeoutMs: 30_000 })
}

export async function pullRuntimeGit(context: RuntimeGitContext): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.pull({
      worktreePath: context.worktreePath,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(target, 'git.pull', { worktree: context.worktreeId }, { timeoutMs: 30_000 })
}

export async function pushRuntimeGit(
  context: RuntimeGitContext,
  args: { publish?: boolean; pushTarget?: GitPushTarget } = {}
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.push({
      worktreePath: context.worktreePath,
      publish: args.publish,
      pushTarget: args.pushTarget,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.push',
    { worktree: context.worktreeId, publish: args.publish, pushTarget: args.pushTarget },
    { timeoutMs: 30_000 }
  )
}

export async function getRuntimeGitBranchDiff(
  context: RuntimeGitContext,
  args: {
    compare: { baseRef: string; baseOid: string; headOid: string; mergeBase: string }
    filePath: string
    oldPath?: string
  }
): Promise<GitDiffResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.branchDiff({
      worktreePath: context.worktreePath,
      compare: args.compare,
      filePath: args.filePath,
      oldPath: args.oldPath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitDiffResult>(
    target,
    'git.branchDiff',
    { worktree: context.worktreeId, ...args },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitCommitDiff(
  context: RuntimeGitContext,
  args: {
    commitOid: string
    parentOid?: string | null
    filePath: string
    oldPath?: string
  }
): Promise<GitDiffResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.commitDiff({
      worktreePath: context.worktreePath,
      commitOid: args.commitOid,
      parentOid: args.parentOid,
      filePath: args.filePath,
      oldPath: args.oldPath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitDiffResult>(
    target,
    'git.commitDiff',
    { worktree: context.worktreeId, ...args },
    { timeoutMs: 15_000 }
  )
}

export async function commitRuntimeGit(
  context: RuntimeGitContext,
  message: string
): Promise<{ success: boolean; error?: string }> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.commit({
      worktreePath: context.worktreePath,
      message,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<{ success: boolean; error?: string }>(
    target,
    'git.commit',
    { worktree: context.worktreeId, message },
    { timeoutMs: 30_000 }
  )
}

export async function generateRuntimeCommitMessage(
  context: RuntimeGitContext
): Promise<RuntimeGenerateCommitMessageResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.generateCommitMessage({
      worktreePath: context.worktreePath,
      connectionId: context.connectionId
    }) as Promise<RuntimeGenerateCommitMessageResult>
  }
  return callRuntimeRpc<RuntimeGenerateCommitMessageResult>(
    target,
    'git.generateCommitMessage',
    {
      worktree: context.worktreeId,
      ...getRuntimeCommitMessageSettings(context.settings)
    },
    { timeoutMs: 75_000 }
  )
}

export async function cancelRuntimeGenerateCommitMessage(
  context: RuntimeGitContext
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.cancelGenerateCommitMessage({
      worktreePath: context.worktreePath,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.cancelGenerateCommitMessage',
    { worktree: context.worktreeId },
    { timeoutMs: 5_000 }
  )
}

export async function stageRuntimeGitPath(
  context: RuntimeGitContext,
  filePath: string
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.stage({
      worktreePath: context.worktreePath,
      filePath,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.stage',
    { worktree: context.worktreeId, filePath },
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
      worktreePath: context.worktreePath,
      filePaths,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.bulkStage',
    { worktree: context.worktreeId, filePaths },
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
      worktreePath: context.worktreePath,
      filePath,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.unstage',
    { worktree: context.worktreeId, filePath },
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
      worktreePath: context.worktreePath,
      filePaths,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.bulkUnstage',
    { worktree: context.worktreeId, filePaths },
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
      worktreePath: context.worktreePath,
      filePaths,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.bulkDiscard',
    { worktree: context.worktreeId, filePaths },
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
      worktreePath: context.worktreePath,
      filePath,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.discard',
    { worktree: context.worktreeId, filePath },
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
      worktreePath: context.worktreePath,
      relativePath: args.relativePath,
      line: args.line,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<string | null>(
    target,
    'git.remoteFileUrl',
    { worktree: context.worktreeId, relativePath: args.relativePath, line: args.line },
    { timeoutMs: 15_000 }
  )
}
