import type { GitStashCreateOptions, GitStashFile, GitStashMutationTarget, GitStashSummary } from '../../../shared/git-stash'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc, getActiveRuntimeTarget, RuntimeRpcCallError } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

function stashAbortError(): Error {
  const error = new Error('Git stash request aborted')
  error.name = 'AbortError'
  return error
}

async function callStash<T>(context: RuntimeGitContext, method: string, params: object, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw stashAbortError()
  }
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    const base = { worktreePath: resolveLocalWorktreePath(context), connectionId: context.connectionId }
    const git = window.api.git
    if (method === 'git.stashList') {
      return callLocalStashRead<T>(git.stashList, base, signal)
    }
    if (method === 'git.stashFiles') {
      return callLocalStashRead<T>(git.stashFiles, { ...base, ...(params as { ref: string }) }, signal)
    }
    if (method === 'git.stashCreate') {
      return git.stashCreate({ ...base, ...(params as GitStashCreateOptions) }) as Promise<T>
    }
    const mutation = params as GitStashMutationTarget
    if (method === 'git.stashApply') {
      return git.stashApply({ ...base, ...mutation }) as Promise<T>
    }
    if (method === 'git.stashPop') {
      return git.stashPop({ ...base, ...mutation }) as Promise<T>
    }
    return git.stashDrop({ ...base, ...mutation }) as Promise<T>
  }
  try {
    return await callRuntimeRpc<T>(target, method, { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...params }, { timeoutMs: 30_000, signal })
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      throw new Error('git_stash_unavailable')
    }
    throw error
  }
}

async function callLocalStashRead<T>(
  invoke: (args: never) => Promise<unknown>,
  args: object,
  signal?: AbortSignal
): Promise<T> {
  const requestToken = `git-stash-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const cancel = (): void => {
    void window.api.git.stashCancel({ requestToken }).catch(() => {})
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const result = await invoke({ ...args, requestToken } as never)
    if (signal?.aborted) {
      throw stashAbortError()
    }
    return result as T
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

export const listRuntimeGitStashes = (context: RuntimeGitContext, signal?: AbortSignal): Promise<GitStashSummary[]> => callStash(context, 'git.stashList', {}, signal)
export const listRuntimeGitStashFiles = (context: RuntimeGitContext, target: GitStashMutationTarget, signal?: AbortSignal): Promise<GitStashFile[]> => callStash(context, 'git.stashFiles', target, signal)
export const createRuntimeGitStash = (context: RuntimeGitContext, options: GitStashCreateOptions): Promise<void> => callStash(context, 'git.stashCreate', options)
export const applyRuntimeGitStash = (context: RuntimeGitContext, target: GitStashMutationTarget): Promise<void> => callStash(context, 'git.stashApply', target)
export const popRuntimeGitStash = (context: RuntimeGitContext, target: GitStashMutationTarget): Promise<void> => callStash(context, 'git.stashPop', target)
export const dropRuntimeGitStash = (context: RuntimeGitContext, target: GitStashMutationTarget): Promise<void> => callStash(context, 'git.stashDrop', target)
