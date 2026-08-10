import type { Repo, WorkspaceSessionState } from '../../../shared/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { adoptOrphanedWorkspaceSessionPartition } from '../../../shared/workspace-session-partition-adoption'

type SshPartitionHydrationApi = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  adoptSshPartition?: (hostId: `ssh:${string}`) => Promise<WorkspaceSessionState>
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

/** Recover SSH tabs through the main process's atomic partition move. */
export async function adoptStrandedSshHostPartitions(
  api: SshPartitionHydrationApi,
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[],
  merged: WorkspaceSessionState
): Promise<WorkspaceSessionState> {
  let session = merged
  for (const hostId of listKnownSshHostIds(repos)) {
    try {
      session = api.adoptSshPartition
        ? await api.adoptSshPartition(hostId as `ssh:${string}`)
        : adoptOrphanedWorkspaceSessionPartition(session, await api.get(hostId)).session
    } catch (err) {
      console.warn(`[session] skipping unreadable host partition ${hostId}:`, err)
    }
  }
  return session
}
