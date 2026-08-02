import { getRepoExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import type { SshHostRemoveResolution } from './ssh-host-remove-resolution'

export type ClearSshHostWorkspacesResult = {
  /** Worktree/repo removals that reported failure ({ ok: false }). Non-empty
   *  means the SSH target should not be reported as fully removed. */
  failedIds: string[]
}

/**
 * Clears the workspaces on an SSH host that is being removed, before the target
 * itself is deleted. Two modes:
 *  - 'delete-remote': the host is connected, so run the normal remote removal
 *    for each worktree (deletes the remote git worktree) and the host-scoped
 *    project removal for each root repo.
 *  - 'forget-local': the host is offline/gone, so only clear Orca's records —
 *    no remote files, worktrees, or branches are touched.
 *
 * Worktrees are removed before their root repos so a root removal never races a
 * still-registered child. Failures are collected (not thrown) so the caller can
 * decide whether to proceed with target removal.
 */
export async function clearSshHostWorkspaces(
  resolution: SshHostRemoveResolution,
  mode: 'delete-remote' | 'forget-local'
): Promise<ClearSshHostWorkspacesResult> {
  const store = useAppStore.getState()
  const forgetLocalOnly = mode === 'forget-local'
  const failedIds: string[] = []

  for (const worktreeId of resolution.workspaceWorktreeIds) {
    // Why: sequential, not parallel — deletes on the same repo contend on git
    // ref locks, and forget is cheap enough that ordering keeps failures legible.
    const result = await store.removeWorktree(
      worktreeId,
      false,
      forgetLocalOnly ? { mode: 'forget-local' } : undefined
    )
    if (!result.ok) {
      failedIds.push(worktreeId)
    }
  }

  // Why: removeProject purges renderer state and (in main) is host-scoped. Pass
  // the explicit SSH host id so a repo id shared with the local host resolves to
  // this host's row instead of falling back to the focused host — otherwise the
  // wrong (local) project could be removed and the SSH ghost left behind. For an
  // offline/ghost host this hits the local backend path (no live runtime target),
  // clearing Orca's records without a successful remote call.
  const hostId = toSshExecutionHostId(resolution.targetId)
  for (const repoId of resolution.hostRepoIds) {
    try {
      await store.removeProject(repoId, { hostId })
    } catch {
      failedIds.push(repoId)
    }
    // Why: removeProject swallows its own errors and returns void, so the
    // try/catch above can't observe a failure. Verify the host's repo row is
    // actually gone; if it lingers, the removal did not succeed.
    const stillPresent = useAppStore
      .getState()
      .repos.some((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId)
    if (stillPresent && !failedIds.includes(repoId)) {
      failedIds.push(repoId)
    }
  }

  return { failedIds }
}
