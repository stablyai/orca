import type { PreloadApi } from '../../../../preload/api-types'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { resolveRuntimeWorktreeUnlessSubmodule } from './web-git-mutations'
import { callRuntimeResult } from './web-runtime-calls'

type GitApi = NonNullable<Partial<PreloadApi>['git']>

export const webGitRemoteActions: Pick<GitApi, 'fetch' | 'push' | 'pull'> = {
  fetch: async ({ worktreePath, pushTarget, submodulePath }) => {
    const worktree = await resolveRuntimeWorktreeUnlessSubmodule(worktreePath, submodulePath)
    await callRuntimeResult('git.fetch', {
      worktree: toRuntimeWorktreeSelector(worktree.id),
      pushTarget
    })
  },
  push: async ({ worktreePath, publish, pushTarget, submodulePath }) => {
    const worktree = await resolveRuntimeWorktreeUnlessSubmodule(worktreePath, submodulePath)
    await callRuntimeResult('git.push', {
      worktree: toRuntimeWorktreeSelector(worktree.id),
      publish,
      pushTarget
    })
  },
  pull: async ({ worktreePath, pushTarget, submodulePath }) => {
    const worktree = await resolveRuntimeWorktreeUnlessSubmodule(worktreePath, submodulePath)
    await callRuntimeResult('git.pull', {
      worktree: toRuntimeWorktreeSelector(worktree.id),
      pushTarget
    })
  }
}
