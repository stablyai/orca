import type { ConfirmedUnsavedDiscards } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import { getRepoExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { runEnclosingWorktreeRemoval } from '@/store/active-worktree-deselection-intent'
import type { SshHostRemoveResolution } from './ssh-host-remove-resolution'

export type ClearSshHostWorkspacesResult = {
  /** Failed IDs prevent reporting the SSH target as fully removed. */
  failedIds: string[]
}

/** Forget children before root repos, collecting failures for the caller. */
async function clearSshHostWorkspacesImpl(
  resolution: SshHostRemoveResolution,
  confirmedDiscards: ConfirmedUnsavedDiscards | undefined
): Promise<ClearSshHostWorkspacesResult> {
  const store = useAppStore.getState()
  const failedIds: string[] = []
  // Pin removals to this SSH target so a same-path local checkout cannot be deleted.
  const hostId = toSshExecutionHostId(resolution.targetId)
  for (const worktreeId of resolution.workspaceWorktreeIds) {
    const result = await store.removeWorktree({ id: worktreeId, executionHostId: hostId }, false, {
      mode: 'forget-local',
      confirmedDiscards
    })
    if (!result.ok) {
      failedIds.push(worktreeId)
    }
  }

  // Use the explicit SSH owner so a shared repo ID cannot resolve to a local or focused-host project.
  for (const repoId of resolution.hostRepoIds) {
    try {
      await store.removeProject(repoId, { hostId, confirmedDiscards })
    } catch {
      failedIds.push(repoId)
    }
    // Project removal may swallow errors; verify that the host-qualified repo row actually disappeared.
    const stillPresent = useAppStore
      .getState()
      .repos.some((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId)
    if (stillPresent && !failedIds.includes(repoId)) {
      failedIds.push(repoId)
    }
  }

  return { failedIds }
}

export async function clearSshHostWorkspaces(
  resolution: SshHostRemoveResolution,
  confirmedDiscards?: ConfirmedUnsavedDiscards
): Promise<ClearSshHostWorkspacesResult> {
  return runEnclosingWorktreeRemoval({ hostId: toSshExecutionHostId(resolution.targetId) }, () =>
    clearSshHostWorkspacesImpl(resolution, confirmedDiscards)
  )
}
