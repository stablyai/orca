import type { Repo, Worktree } from '../../../../shared/types'
import type { SshConnectionState } from '../../../../shared/ssh-types'

/**
 * Classifies what removing an SSH target means for the workspaces still on it,
 * so the host-removal dialog can offer the right choice:
 *  - connected  → can delete host AND its remote worktrees (real git removal)
 *  - offline    → target still configured but not connected; delete would need a
 *                 reconnect, so default to forgetting the workspaces locally
 *  - (no workspaces) → plain host removal, no workspace decision needed
 */
export type SshHostRemoveResolution = {
  targetId: string
  /** Ids of non-main worktrees on this host that a remote delete would remove. */
  workspaceWorktreeIds: string[]
  /** Repo ids whose main/root workspace lives on this host. */
  hostRepoIds: string[]
  workspaceCount: number
  isConnected: boolean
}

export function resolveSshHostRemoval(args: {
  targetId: string
  repos: readonly Pick<Repo, 'id' | 'connectionId'>[]
  worktrees: readonly Pick<Worktree, 'id' | 'repoId' | 'isMainWorktree'>[]
  sshConnectionStates: ReadonlyMap<string, SshConnectionState>
}): SshHostRemoveResolution {
  const hostRepoIds = [
    ...new Set(
      args.repos
        .filter((repo) => repo.connectionId?.trim() === args.targetId)
        .map((repo) => repo.id)
    )
  ]
  const hostRepoIdSet = new Set(hostRepoIds)
  // Why: dedupe by id — the store can transiently hold duplicate worktree rows
  // (e.g. mid host merge), and a doubled row must not inflate the count shown to
  // the user or cause a worktree to be removed twice.
  const workspaceWorktreeIds = [
    ...new Set(
      args.worktrees
        .filter((worktree) => hostRepoIdSet.has(worktree.repoId) && !worktree.isMainWorktree)
        .map((worktree) => worktree.id)
    )
  ]
  const isConnected = args.sshConnectionStates.get(args.targetId)?.status === 'connected'
  return {
    targetId: args.targetId,
    workspaceWorktreeIds,
    hostRepoIds,
    // A repo's main/root workspace counts too — removing the host drops it.
    workspaceCount: workspaceWorktreeIds.length + hostRepoIds.length,
    isConnected
  }
}
