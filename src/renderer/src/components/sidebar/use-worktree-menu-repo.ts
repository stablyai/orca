import { useAppStore } from '@/store'
import {
  findIndexedRepoOwnerForHost,
  resolveIndexedRepoOwner
} from '@/lib/worktree-runtime-owner-index'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

/** The clicked workspace's own repo row. */
export function useWorktreeMenuRepo(worktree: Worktree): Repo | undefined {
  return useAppStore((s) => {
    const resolution = resolveIndexedRepoOwner(s.repos, worktree.repoId)
    if (resolution.kind === 'missing') {
      return undefined
    }
    // Why: repo ids repeat across hosts, so a shared id resolves on the workspace's own host, never the
    // active workspace's; an unstamped workspace without a runtime owner is local, as in the owner index.
    const hostIds: ExecutionHostId[] =
      resolution.kind === 'resolved'
        ? [getRepoExecutionHostId(resolution.owner)]
        : [
            ...(worktree.runtimeOwnerEnvironmentId
              ? [toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)]
              : []),
            getWorktreeExecutionHostId(worktree, undefined)
          ]
    for (const hostId of hostIds) {
      const repo = findIndexedRepoOwnerForHost(s.repos, worktree.repoId, hostId)
      if (repo) {
        return repo
      }
    }
    return undefined
  })
}
