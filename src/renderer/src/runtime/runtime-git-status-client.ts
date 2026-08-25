import type { GitHistoryOptions, GitHistoryResult } from '../../../shared/git-history'
import type {
  GitConflictOperation,
  GitStagingArea,
  GitStatusResult
} from '../../../shared/git-status-types'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

export async function getRuntimeGitStatus(
  context: RuntimeGitContext,
  options?: {
    includeIgnored?: boolean
    bypassEffectiveUpstreamNegativeCache?: boolean
    reuseLineStats?: boolean
    branchLineTotalMergeBase?: string
    signal?: AbortSignal
  }
): Promise<GitStatusResult> {
  const target = getActiveRuntimeTarget(context.settings)
  const includeIgnoredArgs = options?.includeIgnored ? { includeIgnored: true } : {}
  const upstreamCacheBypassArgs = options?.bypassEffectiveUpstreamNegativeCache
    ? { bypassEffectiveUpstreamNegativeCache: true }
    : {}
  const lineStatsReuseArgs = options?.reuseLineStats ? { reuseLineStats: true } : {}
  const branchLineTotalArgs = options?.branchLineTotalMergeBase
    ? { branchLineTotalMergeBase: options.branchLineTotalMergeBase }
    : {}
  if (target.kind === 'local' || !context.worktreeId) {
    return callLocalGitStatus(
      {
        worktreePath: resolveLocalWorktreePath(context),
        connectionId: context.connectionId,
        ...includeIgnoredArgs,
        ...upstreamCacheBypassArgs,
        ...lineStatsReuseArgs,
        ...branchLineTotalArgs
      },
      options?.signal
    )
  }
  return callRuntimeRpc<GitStatusResult>(
    target,
    'git.status',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...includeIgnoredArgs,
      ...upstreamCacheBypassArgs,
      ...lineStatsReuseArgs,
      ...branchLineTotalArgs
    },
    {
      timeoutMs: 15_000,
      // Why: idle safety refreshes stay pooled; activity refreshes need cancellation.
      ...(options?.reuseLineStats ? {} : { signal: options?.signal })
    }
  )
}

export async function setRuntimeGitStatusUpstreamRefWatch(
  context: RuntimeGitContext,
  args: { executionHostId: string; branch?: string; upstreamName?: string }
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'local' || !context.worktreeId) {
    return
  }
  await window.api.git.setStatusUpstreamRefWatch({
    worktreeId: context.worktreeId,
    worktreePath: resolveLocalWorktreePath(context),
    executionHostId: args.executionHostId,
    ...(context.connectionId ? { connectionId: context.connectionId } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    ...(args.upstreamName ? { upstreamName: args.upstreamName } : {})
  })
}

let nextGitStatusRequestToken = 0

function createGitStatusAbortError(): Error {
  const error = new Error('Git status request aborted')
  error.name = 'AbortError'
  return error
}

async function callLocalGitStatus(
  args: Parameters<Window['api']['git']['status']>[0],
  signal?: AbortSignal
): Promise<GitStatusResult> {
  if (!signal) {
    return window.api.git.status(args)
  }
  if (signal.aborted) {
    throw createGitStatusAbortError()
  }
  const requestToken = `git-status-${Date.now()}-${++nextGitStatusRequestToken}`
  const cancel = (): void => {
    void window.api.git.cancelStatus({ requestToken }).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const status = await window.api.git.status({ ...args, requestToken })
    // Why: best-effort cancellation must not publish a late result as fresh.
    if (signal.aborted) {
      throw createGitStatusAbortError()
    }
    return status
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

export async function getRuntimeGitSubmoduleStatus(
  context: RuntimeGitContext,
  submodulePath: string,
  area: GitStagingArea = 'unstaged'
): Promise<GitStatusResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.submoduleStatus({
      worktreePath: resolveLocalWorktreePath(context),
      submodulePath,
      connectionId: context.connectionId,
      area
    })
  }
  return callRuntimeRpc<GitStatusResult>(
    target,
    'git.submoduleStatus',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), submodulePath, area },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitIgnoredPaths(
  context: RuntimeGitContext,
  paths: string[]
): Promise<string[]> {
  const target = getActiveRuntimeTarget(context.settings)
  if (paths.length === 0) {
    return []
  }
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.checkIgnored({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      paths
    })
  }
  return callRuntimeRpc<string[]>(
    target,
    'git.checkIgnored',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), paths },
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
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      ...options
    })
  }
  return callRuntimeRpc<GitHistoryResult>(
    target,
    'git.history',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...options },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitConflictOperation(
  context: RuntimeGitContext
): Promise<GitConflictOperation> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.conflictOperation({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitConflictOperation>(
    target,
    'git.conflictOperation',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
    { timeoutMs: 15_000 }
  )
}
