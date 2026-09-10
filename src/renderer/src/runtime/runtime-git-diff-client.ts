import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitDiffResult
} from '../../../shared/git-diff-compare-types'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

export async function getRuntimeGitDiff(
  context: RuntimeGitContext,
  args: { filePath: string; staged: boolean; compareAgainstHead?: boolean }
): Promise<GitDiffResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.diff({
      worktreePath: resolveLocalWorktreePath(context),
      filePath: args.filePath,
      staged: args.staged,
      compareAgainstHead: args.compareAgainstHead,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitDiffResult>(
    target,
    'git.diff',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...args },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitBranchCompare(
  context: RuntimeGitContext,
  baseRef: string,
  admissionTier: 'interactive' | 'background' = 'interactive'
): Promise<GitBranchCompareResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.branchCompare({
      worktreePath: resolveLocalWorktreePath(context),
      baseRef,
      connectionId: context.connectionId,
      admissionTier
    })
  }
  return callRuntimeRpc<GitBranchCompareResult>(
    target,
    'git.branchCompare',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), baseRef, admissionTier },
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
      worktreePath: resolveLocalWorktreePath(context),
      commitId,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitCommitCompareResult>(
    target,
    'git.commitCompare',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), commitId },
    { timeoutMs: 15_000 }
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
      worktreePath: resolveLocalWorktreePath(context),
      compare: args.compare,
      filePath: args.filePath,
      oldPath: args.oldPath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitDiffResult>(
    target,
    'git.branchDiff',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...args },
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
      worktreePath: resolveLocalWorktreePath(context),
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
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...args },
    { timeoutMs: 15_000 }
  )
}
