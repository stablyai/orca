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
    // Why: the boot snapshot can predate writes that landed on the owner
    // partition. Folding a fresh owner read in first keeps the hydrated session
    // and the owner partition agreeing on which worktrees are still empty and
    // which tabs are retired. Adopting into a worktree the owner repopulated
    // would hand the renderer a copy the owner patch refuses to persist, and
    // the first debounced write would push that stale copy back over the live
    // one.
    const ownerSession = api.patch ? await readOwnerPartition(api, hostId) : null
    const adoption = adoptOrphanedWorkspaceSessionPartition(
      ownerSession ? foldOwnerPartition(session, ownerSession) : session,
      slice
    )
    session = adoption.session
    if (!api.patch || !ownerSession) {
      continue
    }
    try {
      // Why: both patches replace whole fields, so each is built from a read
      // taken after the boot snapshot — a boot-time snapshot would clobber any
      // write that landed on the partition in between. The owner (local)
      // partition persists every adopted field before the source sheds them,
      // so a crash between the two writes cannot strand the adopted tabs with
      // no persisted copy on either side. The source sheds exactly what the
      // owner patch landed, plus the tabs a tombstone retired.
      const ownerPatch = buildAdoptedWorkspaceSessionOwnerPatch(
        ownerSession,
        session,
        adoption.adoptedTabIdsByWorktreeId
      )
      if (!ownerPatch) {
        continue
      }
      await api.patch(ownerPatch.patch)
      const prune = pruneAdoptedWorkspaceSessionPartitionEntries(
        await api.get(hostId),
        ownerPatch.landedTabIdsByWorktreeId,
        adoption.retiredTabIds
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

/** Merge a fresh owner read into the boot snapshot: adopt the entries the
 *  snapshot lacks, and take the owner's tombstones so a pane retired since the
 *  snapshot still fences its tab out of the adoption. */
function foldOwnerPartition(
  session: WorkspaceSessionState,
  ownerSession: WorkspaceSessionState
): WorkspaceSessionState {
  const folded = adoptOrphanedWorkspaceSessionPartition(session, ownerSession).session
  if (!ownerSession.terminalSurfaceTombstonesByPaneKey) {
    return folded
  }
  return {
    ...folded,
    terminalSurfaceTombstonesByPaneKey: {
      ...folded.terminalSurfaceTombstonesByPaneKey,
      ...ownerSession.terminalSurfaceTombstonesByPaneKey
    }
  }
}

/** Read the owner (local) partition, or null when it is unreadable — a failed
 *  read only costs this host its durable move, never the boot. */
async function readOwnerPartition(
  api: SshPartitionHydrationApi,
  hostId: ExecutionHostId
): Promise<WorkspaceSessionState | null> {
  try {
    return await api.get()
  } catch (err) {
    console.warn(`[session] skipping adoption move for ${hostId}, owner read failed:`, err)
    return null
  }
}
