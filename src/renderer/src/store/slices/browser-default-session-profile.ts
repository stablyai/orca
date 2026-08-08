import type { Repo, Worktree } from '../../../../shared/types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { getIndexedWorktreeMap } from '../worktree-repo-index'

export type DefaultBrowserSessionProfileState = {
  repos: Repo[]
  worktreesByRepo: Record<string, Worktree[]>
  defaultBrowserSessionProfileIdByHostId: Partial<Record<ExecutionHostId, string | null>>
  defaultBrowserSessionProfileId: string | null
}

/**
 * A project override wins over the global default so tabs opened in a project
 * land on the account that project expects. Profile ids are host-scoped, so the
 * override is read from the repo row owned by the tab's browser host.
 */
export function resolveDefaultBrowserSessionProfileId(
  state: DefaultBrowserSessionProfileState,
  worktreeId: string,
  hostId: ExecutionHostId
): string | null {
  return (
    getProjectBrowserSessionProfileId(state, worktreeId, hostId) ??
    state.defaultBrowserSessionProfileIdByHostId[hostId] ??
    state.defaultBrowserSessionProfileId
  )
}

function getProjectBrowserSessionProfileId(
  state: DefaultBrowserSessionProfileState,
  worktreeId: string,
  hostId: ExecutionHostId
): string | undefined {
  const repoId = getIndexedWorktreeMap(state.worktreesByRepo).get(worktreeId)?.repoId
  if (!repoId) {
    return undefined
  }
  // Why: no fallback to another host's row — its profile ids do not exist on this host.
  const owner = state.repos.find(
    (repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId
  )
  return owner?.defaultBrowserSessionProfileId
}
