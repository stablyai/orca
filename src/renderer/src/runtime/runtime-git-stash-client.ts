import type { GitStashCreateOptions, GitStashFile, GitStashSummary } from '../../../shared/git-stash'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc, getActiveRuntimeTarget, RuntimeRpcCallError } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

async function callStash<T>(context: RuntimeGitContext, method: string, params: object): Promise<T> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    const base = { worktreePath: resolveLocalWorktreePath(context), connectionId: context.connectionId }
    const git = window.api.git
    if (method === 'git.stashList') {
      return git.stashList(base) as Promise<T>
    }
    if (method === 'git.stashFiles') {
      return git.stashFiles({ ...base, ...(params as { ref: string }) }) as Promise<T>
    }
    if (method === 'git.stashCreate') {
      return git.stashCreate({ ...base, ...(params as GitStashCreateOptions) }) as Promise<T>
    }
    const ref = (params as { ref: string }).ref
    if (method === 'git.stashApply') {
      return git.stashApply({ ...base, ref }) as Promise<T>
    }
    if (method === 'git.stashPop') {
      return git.stashPop({ ...base, ref }) as Promise<T>
    }
    return git.stashDrop({ ...base, ref }) as Promise<T>
  }
  try {
    return await callRuntimeRpc<T>(target, method, { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...params }, { timeoutMs: 30_000 })
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      throw new Error('Git stashes are unavailable on this host. Reconnect to update Orca, then try again.')
    }
    throw error
  }
}

export const listRuntimeGitStashes = (context: RuntimeGitContext): Promise<GitStashSummary[]> => callStash(context, 'git.stashList', {})
export const listRuntimeGitStashFiles = (context: RuntimeGitContext, ref: string): Promise<GitStashFile[]> => callStash(context, 'git.stashFiles', { ref })
export const createRuntimeGitStash = (context: RuntimeGitContext, options: GitStashCreateOptions): Promise<void> => callStash(context, 'git.stashCreate', options)
export const applyRuntimeGitStash = (context: RuntimeGitContext, ref: string): Promise<void> => callStash(context, 'git.stashApply', { ref })
export const popRuntimeGitStash = (context: RuntimeGitContext, ref: string): Promise<void> => callStash(context, 'git.stashPop', { ref })
export const dropRuntimeGitStash = (context: RuntimeGitContext, ref: string): Promise<void> => callStash(context, 'git.stashDrop', { ref })
