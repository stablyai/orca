import type { GitInspectionApi } from '../../../../preload/api/git-inspection-api'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { callRuntimeResult } from './web-runtime-calls'
import { resolveRuntimeWorktreeByPath } from './web-runtime-worktree-catalog'
import { callAbortableRuntimeEnvironment } from '../../runtime/abortable-runtime-environment-call'
import { requireActiveEnvironment, updateEnvironmentFromResponse } from './web-runtime-session'

type StashMethods = 'stashList' | 'stashFiles' | 'stashCancel' | 'stashCreate' | 'stashApply' | 'stashPop' | 'stashDrop'
const abortControllers = new Map<string, AbortController>()

async function target(worktreePath: string): Promise<string> {
  const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
  return toRuntimeWorktreeSelector(worktree.id)
}

export const webGitStashApi: Pick<GitInspectionApi, StashMethods> = {
  stashList: async ({ worktreePath, requestToken }) => callStashRead('git.stashList', { worktree: await target(worktreePath) }, requestToken),
  stashFiles: async ({ worktreePath, ref, expectedCommitId, requestToken }) => callStashRead('git.stashFiles', { worktree: await target(worktreePath), ref, expectedCommitId }, requestToken),
  stashCancel: async ({ requestToken }) => {
    abortControllers.get(requestToken)?.abort()
  },
  stashCreate: async ({ worktreePath, message, includeUntracked, keepIndex }) => callRuntimeResult('git.stashCreate', { worktree: await target(worktreePath), message, includeUntracked, keepIndex }),
  stashApply: async ({ worktreePath, ref, expectedCommitId }) => callRuntimeResult('git.stashApply', { worktree: await target(worktreePath), ref, expectedCommitId }),
  stashPop: async ({ worktreePath, ref, expectedCommitId }) => callRuntimeResult('git.stashPop', { worktree: await target(worktreePath), ref, expectedCommitId }),
  stashDrop: async ({ worktreePath, ref, expectedCommitId }) => callRuntimeResult('git.stashDrop', { worktree: await target(worktreePath), ref, expectedCommitId })
}

async function callStashRead<T>(method: string, params: object, requestToken?: string): Promise<T> {
  if (!requestToken) {
    return callRuntimeResult<T>(method, params)
  }
  const environment = requireActiveEnvironment()
  abortControllers.get(requestToken)?.abort()
  const controller = new AbortController()
  abortControllers.set(requestToken, controller)
  try {
    const response = await callAbortableRuntimeEnvironment(
      environment.id,
      method,
      params,
      undefined,
      controller.signal
    )
    updateEnvironmentFromResponse(environment, response)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result as T
  } finally {
    if (abortControllers.get(requestToken) === controller) {
      abortControllers.delete(requestToken)
    }
  }
}
