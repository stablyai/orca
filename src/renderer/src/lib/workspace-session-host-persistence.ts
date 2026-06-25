import type {
  Repo,
  Worktree,
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree-id'
import {
  mergeWorkspaceSessionsFromHosts,
  splitWorkspaceSessionByHost,
  type HostSessionSlices,
  type HostIdByWorktreeId
} from './workspace-session-host-split'

export type HostPersistenceState = {
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  worktreesByRepo: Record<string, readonly Pick<Worktree, 'id' | 'repoId'>[]>
}

type SessionApi = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
  setSync: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => void
}

/** Map a worktree to the host partition it persists under.
 *
 *  Why: only `runtime:*` worktrees are partitioned out. SSH-owned worktrees stay
 *  in the 'local' partition because the SSH flow already persists them there (in
 *  the unified blob) and separately mirrors them to each target's remote
 *  snapshot — partitioning them too would double-own that data. */
export function buildHostIdByWorktreeId(state: HostPersistenceState): HostIdByWorktreeId {
  const repoById = new Map(state.repos.map((repo) => [repo.id, repo]))
  const repoIdByWorktreeId = new Map<string, string>()
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      repoIdByWorktreeId.set(worktree.id, worktree.repoId)
    }
  }

  return (worktreeId: string): ExecutionHostId => {
    const repoId = repoIdByWorktreeId.get(worktreeId) ?? getRepoIdFromWorktreeId(worktreeId)
    const repo = repoId ? repoById.get(repoId) : undefined
    if (!repo) {
      return LOCAL_EXECUTION_HOST_ID
    }
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    return parsed?.kind === 'runtime' ? parsed.id : LOCAL_EXECUTION_HOST_ID
  }
}

function nonLocalEntries(slices: HostSessionSlices): [ExecutionHostId, WorkspaceSessionState][] {
  return (Object.entries(slices) as [ExecutionHostId, WorkspaceSessionState][]).filter(
    ([hostId, slice]) => hostId !== LOCAL_EXECUTION_HOST_ID && slice !== undefined
  )
}

/** Patch path of the debounced session writer: split the partial patch by owner
 *  host and patch each partition. Returns the promise for the local write so
 *  App.tsx can keep chaining the SSH remote-workspace upload off it. */
export function patchWorkspaceSessionByHost(
  api: SessionApi,
  patch: WorkspaceSessionPatch,
  state: HostPersistenceState
): Promise<void> {
  const slices = splitWorkspaceSessionByHost(
    patch as WorkspaceSessionState,
    buildHostIdByWorktreeId(state)
  )
  const local = (slices[LOCAL_EXECUTION_HOST_ID] ?? patch) as WorkspaceSessionPatch
  const localWrite = api.patch(local)
  for (const [hostId, slice] of nonLocalEntries(slices)) {
    // Why: a failed runtime-partition write must not reject the local chain.
    void api.patch(slice as WorkspaceSessionPatch, hostId).catch((err) => {
      console.warn(`[session] host partition patch failed for ${hostId}:`, err)
    })
  }
  return localWrite
}

/** Synchronous full-session split for the beforeunload / quit paths. */
export function persistWorkspaceSessionByHostSync(
  api: SessionApi,
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): void {
  const slices = splitWorkspaceSessionByHost(payload, buildHostIdByWorktreeId(state))
  api.setSync(slices[LOCAL_EXECUTION_HOST_ID] ?? payload)
  for (const [hostId, slice] of nonLocalEntries(slices)) {
    api.setSync(slice, hostId)
  }
}

/** Collect the distinct runtime hosts owning any persisted repo. */
export function listKnownRuntimeHostIds(
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]
): ExecutionHostId[] {
  const hostIds = new Set<ExecutionHostId>()
  for (const repo of repos) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    if (parsed?.kind === 'runtime') {
      hostIds.add(parsed.id)
    }
  }
  return [...hostIds]
}

/** Boot-time hydration: fetch the local partition plus one partition per known
 *  runtime host (repos are already loaded before session hydration in App.tsx)
 *  and merge them into the unified session the hydrators expect.
 *
 *  Fail-soft: a partition whose fetch rejects is skipped — boot proceeds with
 *  the rest. Corrupt partitions never reach here; persistence zod-validates
 *  each one and falls back to defaults on the main side. */
export async function fetchWorkspaceSessionFromHosts(
  api: Pick<SessionApi, 'get'>,
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]
): Promise<WorkspaceSessionState> {
  const slices: HostSessionSlices = {
    [LOCAL_EXECUTION_HOST_ID]: await api.get()
  }
  await Promise.all(
    listKnownRuntimeHostIds(repos).map(async (hostId) => {
      try {
        slices[hostId] = await api.get(hostId)
      } catch (err) {
        console.warn(`[session] skipping unreadable host partition ${hostId}:`, err)
      }
    })
  )
  return mergeWorkspaceSessionsFromHosts(slices)
}
