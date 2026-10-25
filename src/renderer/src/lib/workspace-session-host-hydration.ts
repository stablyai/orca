import type { Repo } from '../../../shared/repo-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost
} from '../../../shared/worktree-execution-host-resolution'
import {
  adoptStrandedHostPartitionSession,
  partitionRowsTheWriteWontReturn,
  workspaceIdsNamedByPartition
} from '../../../shared/workspace-session-stranded-partition-adoption'
import {
  mergeWorkspaceSessionsWithHostShadow,
  normalizeWorkspaceSessionKeyToWorktreeId
} from './workspace-session-host-contention'
import { nonLocalHostSessionEntries, type HostSessionSlices } from './workspace-session-host-split'

type SessionReadApi = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  /** Enumerate actual persisted partitions, including SSH folder-only hosts absent from repos. Optional channel preserves older-main catalog-only startup. */
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
    // Sleeping agent records can prove a restored runtime workspace before its catalog answers.
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

export function listKnownRuntimeHostIds(
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]
): ExecutionHostId[] {
  return listKnownPartitionHostIds(repos, 'runtime')
}

/** Read SSH partitions separately: local plus ssh:<target> often represents one workspace split by older builds, not rival claimants (#12723). */
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

/** Read local plus saved/repo runtime and SSH partitions, then merge for hydrators. Skip rejected reads; main already validates corrupt partitions and substitutes defaults. */
export async function fetchWorkspaceSessionFromHosts(
  api: SessionReadApi,
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[],
  additionalRuntimeHostIds: readonly ExecutionHostId[] = []
): Promise<WorkspaceSessionState> {
  return (await fetchWorkspaceSessionWithRuntimeHostOwners(api, repos, additionalRuntimeHostIds))
    .session
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
  // Read saved runtime session hosts before their repo catalogs hydrate.
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
      // Sort SSH partitions for deterministic same-ID adoption; catalog order changes on repo add/remove.
      [...sshHostIds].sort().map(async (hostId) => [hostId, await readPartition(hostId)] as const)
    )
  ])
  const merged = mergeWorkspaceSessionsWithHostShadow(slices)
  // Keep SSH out of rival contention splitting: local/ssh are often legacy halves of one workspace. Reunite afterwards, adopting empty session gaps instead of treating them as deletions (#12721).
  let session = merged.session
  // Widen contention evidence during SSH adoption, the only point those excluded partitions meet rival bare IDs.
  const attribution = sshPartitionCatalogAttribution(
    repos,
    sshPartitions,
    merged.contestedSessionKeys
  )
  const primaryHostBySessionKey = { ...merged.primaryHostBySessionKey }
  // Give excluded SSH partitions their own shadows so nonadopted rows survive the next write.
  const shadow: HostSessionSlices = { ...merged.shadow }
  for (const [hostId, slice] of sshPartitions) {
    const adoption = adoptStrandedHostPartitionSession(session, slice, {
      contestedSessionKeys: attribution.contestedSessionKeys,
      ownedSessionKeys: attribution.ownedSessionKeysByHostId.get(hostId),
      foreignSessionKeys: unownedSessionKeys(
        session,
        attribution.contestedSessionKeys,
        attribution.foreignSessionKeysByHostId.get(hostId)
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
      // Read-source ownership overrides local-residue merge results; return adopted SSH rows to their actual partition even without hydrated catalog proof (#12723).
      primaryHostBySessionKey[workspaceId] = hostId
    }
  }
  return {
    session,
    // Derive owners from surviving merged rows, never parked raw rows, or startup creates runtime placeholders for local winners.
    runtimeHostIdByWorkspaceSessionKey: buildRuntimeHostIdByWorkspaceSessionKey(merged.slices),
    contestedHostWorkspaceSessions: shadow,
    contestedPrimaryHostBySessionKey: primaryHostBySessionKey
  }
}

/** Include every stored SSH partition even without a repo; older mains lacking census fall back to catalog hosts. */
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

/** Contested SSH adoption may gap-fill, never replace: evidence is prior local/runtime rivalry, duplicate SSH partitions, or catalog multi-host repo IDs. Mere local/ssh co-presence is the repair’s input, not collision proof. Foreign means positive catalog reattribution; unknown catalogs prove neither, so unhydrated boot still reunites rows. */
function sshPartitionCatalogAttribution(
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[],
  sshPartitions: readonly (readonly [ExecutionHostId, WorkspaceSessionState | null])[],
  mergedContested: ReadonlySet<string>
) {
  const contestedSessionKeys = new Set(mergedContested)
  const foreignSessionKeysByHostId = new Map<ExecutionHostId, Set<string>>()
  const ownedSessionKeysByHostId = new Map<ExecutionHostId, Set<string>>()
  const repoLookup = createRepoRowExecutionHostLookup(repos)
  const ownedByHostId = new Map<ExecutionHostId, Set<string>>()
  for (const [hostId, slice] of sshPartitions) {
    if (!slice) {
      continue
    }
    const foreign = new Set<string>()
    const owned = new Set<string>()
    const catalogOwned = new Set<string>()
    for (const workspaceId of workspaceIdsNamedByPartition(slice)) {
      // Folder keys have no repo; skip resolver work that would only answer unknown for folder:<uuid>.
      const resolution = isWorktreeSessionKey(workspaceId)
        ? resolveWorktreeExecutionHost(repoLookup, {
            repoId: getRepoIdFromWorktreeId(workspaceId),
            hostId: null
          })
        : null
      if (resolution?.kind === 'resolved' && resolution.hostId !== hostId) {
        foreign.add(workspaceId)
        continue
      }
      if (resolution?.kind === 'resolved') {
        catalogOwned.add(workspaceId)
      } else if (resolution?.reason === 'ambiguous') {
        contestedSessionKeys.add(workspaceId)
      }
      owned.add(workspaceId)
    }
    if (foreign.size > 0) {
      foreignSessionKeysByHostId.set(hostId, foreign)
    }
    ownedByHostId.set(hostId, owned)
    ownedSessionKeysByHostId.set(hostId, catalogOwned)
  }
  // Check co-presence after catalog attribution: foreign residue is not a rival and must not withhold the real owner’s rows.
  for (const workspaceId of sessionKeysHeldByMultiplePartitionSets([...ownedByHostId.values()])) {
    contestedSessionKeys.add(workspaceId)
  }
  return { contestedSessionKeys, foreignSessionKeysByHostId, ownedSessionKeysByHostId }
}

function sessionKeysHeldByMultiplePartitionSets(sets: readonly ReadonlySet<string>[]): Set<string> {
  const held = new Set<string>()
  const contested = new Set<string>()
  for (const keys of sets) {
    for (const key of keys) {
      if (held.has(key)) {
        contested.add(key)
      }
      held.add(key)
    }
  }
  return contested
}

/** Exclude foreign keys and contested keys absent from assembled state. Without an existing read source, write would default unknown contested rows to local and re-split storage. Existing contested rows may gap-fill because their partition is retained. One-boot invisibility is preferable to moving/deleting persisted rows. */
function unownedSessionKeys(
  session: WorkspaceSessionState,
  contestedSessionKeys: ReadonlySet<string>,
  foreignSessionKeys: ReadonlySet<string> | undefined
): ReadonlySet<string> {
  if (contestedSessionKeys.size === 0) {
    return foreignSessionKeys ?? new Set<string>()
  }
  const unowned = new Set(foreignSessionKeys ?? [])
  const known = workspaceIdsNamedByPartition(session)
  for (const key of contestedSessionKeys) {
    if (!known.has(normalizeWorkspaceSessionKeyToWorkspaceId(key))) {
      unowned.add(key)
    }
  }
  return unowned
}

/** A worktree session key names its repo before `::`; a folder key names no repo at all. */
function isWorktreeSessionKey(workspaceId: string): boolean {
  return workspaceId.includes('::')
}
