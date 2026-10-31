import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

/** A host's workspaces can only be forgotten here (this app's main serves no ssh: host); empty hosts need no workspace choice. */
export type SshHostRemoveResolution = {
  targetId: string
  /** Ids of non-main worktrees on this host. */
  workspaceWorktreeIds: string[]
  /** Repo ids whose main/root workspace lives on this host. */
  hostRepoIds: string[]
  workspaceCount: number
}

export function resolveSshHostRemoval(args: {
  targetId: string
  repos: readonly Pick<Repo, 'id' | 'connectionId'>[]
  worktrees: readonly Pick<Worktree, 'id' | 'repoId' | 'isMainWorktree'>[]
}): SshHostRemoveResolution {
  const hostRepoIds = [
    ...new Set(
      args.repos
        .filter((repo) => repo.connectionId?.trim() === args.targetId)
        .map((repo) => repo.id)
    )
  ]
  const hostRepoIdSet = new Set(hostRepoIds)
  // Transient duplicate rows must not inflate counts or trigger duplicate removals.
  const workspaceWorktreeIds = [
    ...new Set(
      args.worktrees
        .filter((worktree) => hostRepoIdSet.has(worktree.repoId) && !worktree.isMainWorktree)
        .map((worktree) => worktree.id)
    )
  ]
  return {
    targetId: args.targetId,
    workspaceWorktreeIds,
    hostRepoIds,
    // A repo's main/root workspace counts too — removing the host drops it.
    workspaceCount: workspaceWorktreeIds.length + hostRepoIds.length
  }
}
