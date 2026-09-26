import type { Repo } from '../../../shared/repo-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  adoptStrandedHostPartitionSession,
  partitionRowsTheWriteWontReturn
} from '../../../shared/workspace-session-stranded-partition-adoption'
import {
  mergeWorkspaceSessionsWithHostShadow,
  normalizeWorkspaceSessionKeyToWorktreeId
} from './workspace-session-host-contention'
import {
  reconciledWorktreeIdsForHost,
  sshPartitionCatalogAttribution,
  unownedSessionKeys
} from './workspace-session-host-reconciliation'
import { nonLocalHostSessionEntries, type HostSessionSlices } from './workspace-session-host-split'

type SessionReadApi = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  /** Every partition persistence actually holds. Boot used to infer the set from the repo catalog
   *  alone, which cannot see an SSH target whose only workspace is a folder — that partition was
   *  written by the runtime and then read by nobody. Optional so a renderer paired with an older
   *  main still boots on the catalog-derived set. */
  listHostIds?: () => Promise<ExecutionHostId[]>
}

export type WorkspaceSessionHostRead = {
  session: WorkspaceSessionState
  runtimeHostIdByWorkspaceSessionKey: Record<string, ExecutionHostId>
  contestedHostWorkspaceSessions: HostSessionSlices
  contestedPrimaryHostBySessionKey: Record<string, ExecutionHostId>
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

function addWorkspaceSessionKeyForOwnerMap(ids: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    ids.add(normalizeWorkspaceSessionKeyToWorktreeId(value))
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
  for (const [hostId, slice] of nonLocalHostSessionEntries(slices)) {
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

/** Collect the distinct runtime hosts owning any persisted repo. */
export function listKnownRuntimeHostIds(
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]
): ExecutionHostId[] {
  return listKnownPartitionHostIds(repos, 'runtime')
}

/** Collect the distinct SSH hosts owning any persisted repo. Their partitions are read separately
 *  from the runtime ones: an `ssh:*` partition is not a rival claimant of the same workspace id,
 *  it is the other half of ONE host's session that shipping builds split in two (#12723). */
export function listKnownSshHostIds(
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]
): ExecutionHostId[] {
  return listKnownPartitionHostIds(repos, 'ssh')
}

function listKnownPartitionHostIds(
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[],
  kind: 'ssh' | 'runtime'
): ExecutionHostId[] {
  const hostIds = new Set<ExecutionHostId>()
  for (const repo of repos) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    if (parsed?.kind === kind) {
      hostIds.add(parsed.id)
    }
  }
  return [...hostIds]
}

/** Boot-time hydration: fetch the local partition, one partition per known runtime host (from
 *  loaded repos and saved runtime ids) and one per known SSH host, then merge them into the
 *  unified session the hydrators expect.
 *
 *  Fail-soft: a partition whose fetch rejects is skipped — boot proceeds with
 *  the rest. Corrupt partitions never reach here; persistence zod-validates
 *  each one and falls back to defaults on the main side. */
export async function fetchWorkspaceSessionFromHosts(
  api: SessionReadApi,
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[],
  additionalRuntimeHostIds: readonly ExecutionHostId[] = []
): Promise<WorkspaceSessionState> {
  return (await fetchWorkspaceSessionWithRuntimeHostOwners(api, repos, additionalRuntimeHostIds))
    .session
}

function wasTargetConnectedAtLastShutdown(
  session: WorkspaceSessionState,
  targetId: string | null
): boolean {
  if (!targetId) {
    return false
  }
  if (session.activeConnectionIdsAtShutdown !== undefined) {
    return session.activeConnectionIdsAtShutdown.includes(targetId)
  }
  // When activeConnectionIdsAtShutdown is undefined (older persisted sessions, interrupted
  // shutdowns), infer connection status from remoteSessionIdsByTabId: if the base session still
  // holds a remote PTY session for this target, the client was connected to it, so do not decline.
  for (const sessionId of Object.values(session.remoteSessionIdsByTabId ?? {})) {
    if (parseAppSshPtyId(sessionId)?.connectionId === targetId) {
      return true
    }
  }
  return false
}

export async function fetchWorkspaceSessionWithRuntimeHostOwners(
  api: SessionReadApi,
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[],
  additionalRuntimeHostIds: readonly ExecutionHostId[] = []
): Promise<WorkspaceSessionHostRead> {
  const readPartition = async (hostId: ExecutionHostId): Promise<WorkspaceSessionState | null> => {
    try {
      return await api.get(hostId)
    } catch (err) {
      console.warn(`[session] skipping unreadable host partition ${hostId}:`, err)
      return null
    }
  }
  const slices: HostSessionSlices = {
    [LOCAL_EXECUTION_HOST_ID]: await api.get()
  }
  // Why: startup can know saved runtime session hosts before their repo
  // catalogs hydrate, so include those partitions in the first read.
  const runtimeHostIds = new Set<ExecutionHostId>([
    ...listKnownRuntimeHostIds(repos),
    ...additionalRuntimeHostIds
  ])
  const sshHostIds = new Set<ExecutionHostId>(listKnownSshHostIds(repos))
  for (const hostId of await listPersistedSshPartitionHostIds(api)) {
    sshHostIds.add(hostId)
  }
  const [, sshPartitions] = await Promise.all([
    Promise.all(
      [...runtimeHostIds].map(async (hostId) => {
        const slice = await readPartition(hostId)
        if (slice) {
          slices[hostId] = slice
        }
      })
    ),
    Promise.all(
      // Sorted so two SSH partitions naming one bare id resolve the same way on every boot; the
      // repo catalog's order is not stable across repo add/remove.
      [...sshHostIds].sort().map(async (hostId) => [hostId, await readPartition(hostId)] as const)
    )
  ])
  const merged = mergeWorkspaceSessionsWithHostShadow(slices)
  // Why the ssh partitions stay out of `slices`: the contention split reads two slices holding one
  // workspace id as two DIFFERENT workspaces on rival hosts and parks one of them. 'local' and
  // `ssh:<targetId>` are the same workspace written twice, so they are reunited afterwards instead
  // — and a workspace the merged session has no tabs for is adopted rather than read as a
  // deletion (#12721). Routing sends the reunited rows back to the owning partition.
  let session = merged.session
  // Why the merge's verdict is widened here: it arbitrates only the slices it was given, and the
  // ssh ones are kept out of that claimant set on purpose. Adoption is the one place an ssh row
  // meets a bare id another host also claims.
  const attribution = sshPartitionCatalogAttribution(
    repos,
    sshPartitions,
    merged.contestedSessionKeys
  )
  const primaryHostBySessionKey = { ...merged.primaryHostBySessionKey }
  // Why the ssh partitions get shadow entries of their own: the contention split only parks rows
  // for the slices it arbitrates, and these are not among them. Everything this read leaves behind
  // in an ssh partition still has to survive the next write to it.
  const shadow: HostSessionSlices = { ...merged.shadow }
  for (const [hostId, slice] of sshPartitions) {
    const targetId = getSshTargetIdForExecutionHost(hostId)
    const adoption = adoptStrandedHostPartitionSession(session, slice, {
      contestedSessionKeys: attribution.contestedSessionKeys,
      foreignSessionKeys: unownedSessionKeys(
        session,
        attribution.contestedSessionKeys,
        attribution.foreignSessionKeysByHostId.get(hostId)
      ),
      reconciledWorktreeIds: reconciledWorktreeIdsForHost(
        attribution,
        hostId,
        wasTargetConnectedAtLastShutdown(merged.session, targetId)
      )
    })
    session = adoption.session
    if (slice) {
      const parked = partitionRowsTheWriteWontReturn(slice, adoption.adoptedWorkspaceIds)
      if (parked) {
        shadow[hostId] = parked
      }
    }
    for (const workspaceId of adoption.adoptedWorkspaceIds) {
      // Why this overrides the merge's answer: the merge saw only the leftover half in 'local' and
      // named it the owner. These rows came out of the partition that owns them, and routing has to
      // return them there even on a boot whose repo catalog cannot name the host yet — otherwise
      // the write moves them back into 'local' and re-strands them (#12723).
      primaryHostBySessionKey[workspaceId] = hostId
    }
  }
  return {
    session,
    // Why the merged slices and not the raw ones: a row parked out of the renderer session must not
    // still name its host as the owner, or startup builds runtime placeholders for a local row.
    runtimeHostIdByWorkspaceSessionKey: buildRuntimeHostIdByWorkspaceSessionKey(merged.slices),
    contestedHostWorkspaceSessions: shadow,
    contestedPrimaryHostBySessionKey: primaryHostBySessionKey
  }
}

/** SSH partitions persistence holds, whether or not a repo still names the target. Fail-soft: an
 *  older main without the channel leaves the catalog-derived set as the whole answer. */
async function listPersistedSshPartitionHostIds(api: SessionReadApi): Promise<ExecutionHostId[]> {
  if (!api.listHostIds) {
    return []
  }
  try {
    return (await api.listHostIds()).filter(
      (hostId) => parseExecutionHostId(hostId)?.kind === 'ssh'
    )
  } catch (err) {
    console.warn('[session] skipping the persisted partition census:', err)
    return []
  }
}
