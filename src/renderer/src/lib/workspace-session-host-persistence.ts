import type { Repo, WorkspaceSessionPatch, WorkspaceSessionState } from '../../../shared/types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree-id'
import {
  mergeWorkspaceSessionsFromHosts,
  splitWorkspaceSessionByHost,
  type HostSessionSlices,
  type HostIdByWorktreeId
} from './workspace-session-host-split'
import {
  indexWorkspaceRuntimeHostOwnership,
  type WorkspaceRuntimeOwnerProjection
} from './workspace-runtime-host-ownership'

export type HostPersistenceState = {
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  projectGroups?: readonly { id: string; executionHostId?: string | null }[]
  folderWorkspaces?: readonly { id: string; projectGroupId: string }[]
  worktreesByRepo: Record<string, readonly WorkspaceRuntimeOwnerProjection[]>
  restoredRuntimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
}

type SessionApi = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
  setSync: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => void
}

type DurableSessionApi = SessionApi & {
  set: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => Promise<void>
  flush: () => Promise<void>
}

export type WorkspaceSessionHostRead = {
  session: WorkspaceSessionState
  runtimeHostIdByWorkspaceSessionKey: Record<string, ExecutionHostId>
}

export type WorkspaceSessionHostSnapshot = {
  state: WorkspaceSessionState
  hostId?: ExecutionHostId
}

const WORKSPACE_SESSION_KEYED_FIELDS = [
  'tabsByWorktree',
  'openFilesByWorktree',
  'activeFileIdByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabIdByWorktree',
  'browserTabsByWorktree',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'activeGroupIdByWorktree',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeWorkspaceSessionKeyForOwnerMap(value: string): string {
  const scope = parseWorkspaceKey(value)
  return scope?.type === 'worktree' ? scope.worktreeId : value
}

function addWorkspaceSessionKeyForOwnerMap(ids: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    ids.add(normalizeWorkspaceSessionKeyForOwnerMap(value))
  }
}

function collectWorkspaceSessionKeysFromHostSession(session: WorkspaceSessionState): string[] {
  const ids = new Set<string>()
  for (const field of WORKSPACE_SESSION_KEYED_FIELDS) {
    const value = session[field]
    if (isPlainRecord(value)) {
      for (const id of Object.keys(value)) {
        addWorkspaceSessionKeyForOwnerMap(ids, id)
      }
    }
  }
  for (const id of session.activeWorktreeIdsOnShutdown ?? []) {
    addWorkspaceSessionKeyForOwnerMap(ids, id)
  }
  for (const pages of Object.values(session.browserPagesByWorkspace ?? {})) {
    if (!Array.isArray(pages)) {
      continue
    }
    for (const page of pages) {
      addWorkspaceSessionKeyForOwnerMap(ids, page.worktreeId)
    }
  }
  for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
    // Why: a hibernated agent can be the only restored session evidence for a
    // runtime worktree before its remote catalog answers.
    addWorkspaceSessionKeyForOwnerMap(ids, record.worktreeId)
  }
  return [...ids]
}

function buildRuntimeHostIdByWorkspaceSessionKey(
  slices: HostSessionSlices
): Record<string, ExecutionHostId> {
  const owners: Record<string, ExecutionHostId> = {}
  const ambiguous = new Set<string>()
  for (const [hostId, slice] of nonLocalEntries(slices)) {
    for (const worktreeId of collectWorkspaceSessionKeysFromHostSession(slice)) {
      if (owners[worktreeId] && owners[worktreeId] !== hostId) {
        ambiguous.add(worktreeId)
        delete owners[worktreeId]
      } else if (!ambiguous.has(worktreeId)) {
        owners[worktreeId] = hostId
      }
    }
  }
  return owners
}

function getRestoredRuntimeHostId(
  owners: Record<string, ExecutionHostId> | undefined,
  key: string
): ExecutionHostId | null {
  const hostId = owners?.[key]
  return hostId && parseExecutionHostId(hostId)?.kind === 'runtime' ? hostId : null
}

function getFolderWorkspaceRuntimeHostId(
  state: HostPersistenceState,
  key: string
): ExecutionHostId {
  const scope = parseWorkspaceKey(key)
  if (scope?.type !== 'folder') {
    return LOCAL_EXECUTION_HOST_ID
  }
  const workspace = state.folderWorkspaces?.find((entry) => entry.id === scope.folderWorkspaceId)
  const group = workspace
    ? state.projectGroups?.find((entry) => entry.id === workspace.projectGroupId)
    : null
  const parsed = parseExecutionHostId(group?.executionHostId)
  if (parsed) {
    return parsed.kind === 'runtime' ? parsed.id : LOCAL_EXECUTION_HOST_ID
  }
  if (workspace && group) {
    // Why: once the folder and group catalogs are both known, a missing runtime
    // owner is authoritative local/SSH persistence, not a startup gap.
    return LOCAL_EXECUTION_HOST_ID
  }
  const restoredHostId = getRestoredRuntimeHostId(
    state.restoredRuntimeHostIdByWorkspaceSessionKey,
    key
  )
  return restoredHostId ?? LOCAL_EXECUTION_HOST_ID
}

/** Map a worktree to the host partition it persists under.
 *
 *  Why: only `runtime:*` worktrees are partitioned out. SSH-owned worktrees stay
 *  in the 'local' partition because the SSH flow already persists them there (in
 *  the unified blob) and separately mirrors them to each target's remote
 *  snapshot — partitioning them too would double-own that data. */
export function buildHostIdByWorktreeId(state: HostPersistenceState): HostIdByWorktreeId {
  const repoHostById = new Map<string, ExecutionHostId | null>()
  for (const repo of state.repos) {
    const hostId = getRepoExecutionHostId(repo)
    const existing = repoHostById.get(repo.id)
    // Why: repo ids can repeat across hosts; ambiguous repo-only ownership
    // must not let a runtime placeholder steal local session state.
    repoHostById.set(repo.id, existing === undefined ? hostId : existing === hostId ? hostId : null)
  }
  const { repoIdByWorktreeId, runtimeHostIdByWorktreeId } = indexWorkspaceRuntimeHostOwnership(
    state.worktreesByRepo
  )

  return (worktreeId: string): ExecutionHostId => {
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      return getFolderWorkspaceRuntimeHostId(state, worktreeId)
    }
    const rawWorktreeId =
      workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : worktreeId
    const worktreeHostId = runtimeHostIdByWorktreeId.get(rawWorktreeId)
    if (runtimeHostIdByWorktreeId.has(rawWorktreeId) && !worktreeHostId) {
      // Why: a bare worktree id cannot safely select between two HUB partitions.
      return LOCAL_EXECUTION_HOST_ID
    }
    if (worktreeHostId) {
      return worktreeHostId
    }
    const repoId = repoIdByWorktreeId.get(rawWorktreeId) ?? getRepoIdFromWorktreeId(rawWorktreeId)
    const repoHostId = repoId ? repoHostById.get(repoId) : undefined
    if (!repoHostId) {
      return LOCAL_EXECUTION_HOST_ID
    }
    const parsed = parseExecutionHostId(repoHostId)
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

/** Persist a fresh full snapshot to every owning host partition, then force the
 * main store to disk. Used by request/reply lifecycle operations whose success
 * receipt is a durability boundary rather than a debounced UI update. */
export async function persistWorkspaceSessionByHost(
  api: DurableSessionApi,
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): Promise<void> {
  const slices = splitWorkspaceSessionByHost(payload, buildHostIdByWorktreeId(state))
  const writes: Promise<void>[] = [api.set(slices[LOCAL_EXECUTION_HOST_ID] ?? payload)]
  for (const [hostId, slice] of nonLocalEntries(slices)) {
    writes.push(api.set(slice, hostId))
  }
  await Promise.all(writes)
  await api.flush()
}

/** Build local-first full-session snapshots for the beforeunload / quit paths. */
export function buildWorkspaceSessionHostSnapshots(
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): WorkspaceSessionHostSnapshot[] {
  const slices = splitWorkspaceSessionByHost(payload, buildHostIdByWorktreeId(state))
  return [
    { state: slices[LOCAL_EXECUTION_HOST_ID] ?? payload },
    ...nonLocalEntries(slices).map(([hostId, hostState]) => ({ state: hostState, hostId }))
  ]
}

/** Synchronous full-session split for the beforeunload / quit paths. */
export function persistWorkspaceSessionByHostSync(
  api: SessionApi,
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): void {
  for (const snapshot of buildWorkspaceSessionHostSnapshots(payload, state)) {
    api.setSync(snapshot.state, snapshot.hostId)
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
 *  runtime host (from loaded repos and saved runtime ids), then merge them into
 *  the unified session the hydrators expect.
 *
 *  Fail-soft: a partition whose fetch rejects is skipped — boot proceeds with
 *  the rest. Corrupt partitions never reach here; persistence zod-validates
 *  each one and falls back to defaults on the main side. */
export async function fetchWorkspaceSessionFromHosts(
  api: Pick<SessionApi, 'get'>,
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[],
  additionalRuntimeHostIds: readonly ExecutionHostId[] = []
): Promise<WorkspaceSessionState> {
  return (await fetchWorkspaceSessionWithRuntimeHostOwners(api, repos, additionalRuntimeHostIds))
    .session
}

export async function fetchWorkspaceSessionWithRuntimeHostOwners(
  api: Pick<SessionApi, 'get'>,
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[],
  additionalRuntimeHostIds: readonly ExecutionHostId[] = []
): Promise<WorkspaceSessionHostRead> {
  const slices: HostSessionSlices = {
    [LOCAL_EXECUTION_HOST_ID]: await api.get()
  }
  // Why: startup can know saved runtime session hosts before their repo
  // catalogs hydrate, so include those partitions in the first read.
  const runtimeHostIds = new Set<ExecutionHostId>([
    ...listKnownRuntimeHostIds(repos),
    ...additionalRuntimeHostIds
  ])
  await Promise.all(
    [...runtimeHostIds].map(async (hostId) => {
      try {
        slices[hostId] = await api.get(hostId)
      } catch (err) {
        console.warn(`[session] skipping unreadable host partition ${hostId}:`, err)
      }
    })
  )
  return {
    session: mergeWorkspaceSessionsFromHosts(slices),
    runtimeHostIdByWorkspaceSessionKey: buildRuntimeHostIdByWorkspaceSessionKey(slices)
  }
}
