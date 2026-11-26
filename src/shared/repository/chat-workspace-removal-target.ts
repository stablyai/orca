import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../execution-host/execution-host'
import { normalizeRuntimePathForComparison } from '../file-access/cross-platform-path'
import type { Repo } from './repo-types'

export type ChatWorkspaceRemovalTarget = { repo: string; repoHostId: ExecutionHostId }

export function chatWorkspaceRemovalTarget(
  row: { repoId: string; path: string; hostId?: ExecutionHostId; isMainWorktree?: boolean },
  repos: readonly Pick<Repo, 'id' | 'path' | 'chatWorkspace' | 'connectionId' | 'executionHostId'>[]
): ChatWorkspaceRemovalTarget | null {
  if (row.isMainWorktree !== true || row.hostId === undefined) {
    return null
  }
  const path = normalizeRuntimePathForComparison(row.path)
  const matches = repos.filter(
    (repo) =>
      repo.chatWorkspace &&
      repo.id === row.repoId &&
      normalizeRuntimePathForComparison(repo.path) === path &&
      getRepoExecutionHostId(repo) === row.hostId
  )
  if (matches.length !== 1) {
    return null
  }
  const host = getRepoExecutionHostId(matches[0])
  return {
    repo: `id:${row.repoId}`,
    // The scoped RPC client reaches the paired server, where its own projects are local.
    repoHostId: host.startsWith('runtime:') ? LOCAL_EXECUTION_HOST_ID : host
  }
}
