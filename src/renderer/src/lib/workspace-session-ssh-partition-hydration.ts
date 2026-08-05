import type { Repo, WorkspaceSessionPatch, WorkspaceSessionState } from '../../../shared/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  adoptOrphanedWorkspaceSessionPartition,
  buildAdoptedWorkspaceSessionOwnerPatch,
  pruneAdoptedWorkspaceSessionPartitionEntries
} from '../../../shared/workspace-session-partition-adoption'

type SshPartitionHydrationApi = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  patch?: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
}

/** Collect the distinct SSH hosts owning any persisted repo. */
export function listKnownSshHostIds(
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]
): ExecutionHostId[] {
  const hostIds = new Set<ExecutionHostId>()
  for (const repo of repos) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    if (parsed?.kind === 'ssh') {
      hostIds.add(parsed.id)
    }
  }
  return [...hostIds]
}

/** Boot-time recovery for session state stranded in `ssh:` host partitions.
 *
 *  SSH worktrees are local-owned in renderer persistence, but main-process
 *  runtime flows persist their session state under `ssh:<targetId>` partitions
 *  that ordinary hydration never reads. Any worktree whose only populated tab
 *  list lives there renders empty — and the remote-workspace round trip then
 *  deletes it everywhere. This reads those partitions, adopts orphaned entries
 *  into the unified session, and completes each adoption as a move: the local
 *  partition gains the adopted state first, then the source partition sheds it
 *  so the same tabs cannot be re-adopted after the user closes them. */
export async function adoptStrandedSshHostPartitions(
  api: SshPartitionHydrationApi,
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[],
  merged: WorkspaceSessionState
): Promise<WorkspaceSessionState> {
  const sshSlices: [ExecutionHostId, WorkspaceSessionState][] = []
  await Promise.all(
    listKnownSshHostIds(repos).map(async (hostId) => {
      try {
        sshSlices.push([hostId, await api.get(hostId)])
      } catch (err) {
        console.warn(`[session] skipping unreadable host partition ${hostId}:`, err)
      }
    })
  )
  let session = merged
  for (const [hostId, slice] of sshSlices) {
    const adoption = adoptOrphanedWorkspaceSessionPartition(session, slice)
    if (adoption.session === session) {
      continue
    }
    session = adoption.session
    if (!api.patch) {
      continue
    }
    try {
      // Why: both patches replace whole fields, so each is built from a fresh
      // read taken just before the write — a boot-time snapshot would clobber
      // any write that landed on the partition in between. The owner (local)
      // partition persists every adopted field before the source sheds them,
      // so a crash between the two writes cannot strand the adopted tabs with
      // no persisted copy on either side.
      const ownerPatch = buildAdoptedWorkspaceSessionOwnerPatch(
        await api.get(),
        session,
        adoption.adoptedTabIdsByWorktreeId
      )
      if (ownerPatch) {
        await api.patch(ownerPatch)
      }
      const prune = pruneAdoptedWorkspaceSessionPartitionEntries(
        await api.get(hostId),
        adoption.adoptedTabIdsByWorktreeId
      )
      if (prune) {
        await api.patch(prune, hostId)
      }
    } catch (err) {
      console.warn(`[session] adopting orphaned ssh partition ${hostId} failed:`, err)
    }
  }
  return session
}
