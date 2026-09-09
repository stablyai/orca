import type { GitInspectionApi } from '../../../../preload/api/git-inspection-api'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { callRuntimeResult } from './web-runtime-calls'
import { resolveRuntimeWorktreeByPath } from './web-runtime-worktree-catalog'

type StashMethods = 'stashList' | 'stashFiles' | 'stashCancel' | 'stashCreate' | 'stashApply' | 'stashPop' | 'stashDrop'

async function target(worktreePath: string): Promise<string> {
  const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
  return toRuntimeWorktreeSelector(worktree.id)
}

export const webGitStashApi: Pick<GitInspectionApi, StashMethods> = {
  stashList: async ({ worktreePath }) => callRuntimeResult('git.stashList', { worktree: await target(worktreePath) }),
  stashFiles: async ({ worktreePath, ref }) => callRuntimeResult('git.stashFiles', { worktree: await target(worktreePath), ref }),
  stashCancel: async () => {},
  stashCreate: async ({ worktreePath, message, includeUntracked, keepIndex }) => callRuntimeResult('git.stashCreate', { worktree: await target(worktreePath), message, includeUntracked, keepIndex }),
  stashApply: async ({ worktreePath, ref }) => callRuntimeResult('git.stashApply', { worktree: await target(worktreePath), ref }),
  stashPop: async ({ worktreePath, ref }) => callRuntimeResult('git.stashPop', { worktree: await target(worktreePath), ref }),
  stashDrop: async ({ worktreePath, ref }) => callRuntimeResult('git.stashDrop', { worktree: await target(worktreePath), ref })
}
