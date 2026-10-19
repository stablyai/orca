import { useAppStore } from '@/store'
import { findIndexedRepoOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import {
  getWorktreeExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

/** The clicked workspace's own repo row. */
export function useWorktreeMenuRepo(worktree: Worktree): Repo | undefined {
  // Why: repo ids repeat across hosts, so resolve the row on the workspace's own host, never the
  // active workspace's; an unstamped row without a runtime owner is local, as in the owner index.
  return useAppStore(
    (s) =>
      findIndexedRepoOwnerForHost(
        s.repos,
        worktree.repoId,
        worktree.runtimeOwnerEnvironmentId
          ? toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
          : getWorktreeExecutionHostId(worktree, undefined)
      ) ?? undefined
  )
}
