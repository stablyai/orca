import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import type { AppState } from '@/store/types'
import { getKnownExecutionHostIdForWorktree } from './worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import { resolveOwner } from './resolve-owner'
import type { Repo } from '../../../../../shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  isUnresolvedOwnerHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  authorityKey,
  parseHostAuthorityKey,
  type HostAuthorityKey
} from '../../../../../shared/execution-host/host-authority'

export type WorktreeOwnerRepoState = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'floatingWorkspacePath'
> &
  WorktreeRuntimeOwnerState

/** A repo row's full host authority, including an SSH target nested under an environment. */
export function repoRouteAuthorityKey(repo: Repo): HostAuthorityKey | null {
  const authority = parseHostAuthorityKey(getRepoExecutionHostId(repo))
  if (!authority) {
    return null
  }
  const connectionId = getRepoSshConnectionId(repo)
  return authorityKey(
    authority.endpoint.kind === 'environment' && connectionId
      ? { ...authority, at: toSshExecutionHostId(connectionId) }
      : authority
  )
}

/** One registered route, including its endpoint, nested target and account binding. */
export function repoRouteIdentity(repo: Repo): string {
  return JSON.stringify([
    repoRouteAuthorityKey(repo),
    repo.id,
    repo.path,
    repo.kind ?? 'git',
    repo.connectionId ?? null,
    repo.ghAccount?.host ?? null,
    repo.ghAccount?.user ?? null,
    repo.upstream ?? null,
    repo.gitRemoteIdentity ?? null
  ])
}

/** The git row that owns a known worktree on its resolved host, or null when none matches exactly. */
export function resolveWorktreeOwnerRepo(
  state: WorktreeOwnerRepoState,
  worktreeId: string | undefined,
  pinnedHostId?: ExecutionHostId
): Repo | null {
  // The same owner the chat's file links route to; twins on other hosts must not answer for it.
  const hostId = worktreeId
    ? (pinnedHostId ?? getKnownExecutionHostIdForWorktree(state, worktreeId))
    : null
  if (!worktreeId || !hostId || isUnresolvedOwnerHostId(hostId)) {
    return null
  }
  const worktree = findKnownWorktreeById(state, worktreeId, hostId)
  if (!worktree) {
    return null
  }
  const owner = resolveOwner(state, { workspaceId: worktreeId, hostId: pinnedHostId })
  if (owner.kind !== 'resolved') {
    return null
  }
  const owners = state.repos.filter(
    (candidate) =>
      candidate.id === worktree.repoId &&
      repoRouteAuthorityKey(candidate) === authorityKey(owner.owner)
  )
  const found = owners.length === 1 ? owners[0] : null
  return found && (!found.kind || found.kind === 'git') ? found : null
}
