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
  // Every workspace in this resolution is pinned to the SSH target being
  // removed, so that target is the host each removal is confirmed against
  // (STA-4343) — a bare id could land on a local checkout at the same path.
  const hostId = toSshExecutionHostId(resolution.targetId)

  for (const worktreeId of resolution.workspaceWorktreeIds) {
    // Why: sequential, not parallel — deletes on the same repo contend on git
    // ref locks, and forget is cheap enough that ordering keeps failures legible.
    const result = await store.removeWorktree(
      { id: worktreeId, executionHostId: hostId },
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
  // wrong (local) project could be removed and the SSH ghost left behind.
  // Why: forward the mode too. Without it a repo whose owner settings resolve a runtime target
  // would dispatch repo.rm (and, for a runtime-owned SSH target, destroy its ephemeral VM) during
  // an operation defined as touching nothing outside this client.
  for (const repoId of resolution.hostRepoIds) {
    try {
      const outcome = await store.removeProject(
        repoId,
        forgetLocalOnly ? { hostId, mode: 'forget-local' as const } : { hostId }
      )
      if (outcome.status !== 'removed') {
        failedIds.push(repoId)
      }
    } catch {
      failedIds.push(repoId)
    }
    // Why: removeProject reports its own outcome, but a returned status is not proof of the
    // durable change. Verify the host's repo row is actually gone; if it lingers, the removal
    // did not succeed.
    const stillPresent = useAppStore
      .getState()
      .repos.some((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId)
    if (stillPresent && !failedIds.includes(repoId)) {
      failedIds.push(repoId)
    }
  }

  return { failedIds }
}
