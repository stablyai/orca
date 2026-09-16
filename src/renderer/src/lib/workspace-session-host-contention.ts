import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../shared/workspace-session-host-field-ownership'
import {
  isWorkspaceSessionRecord,
  type WorkspaceSessionRecord
} from './workspace-session-host-records'
import type { WorkspaceRuntimeOwnerProjection } from './workspace-runtime-host-ownership'
import {
  mergeWorkspaceSessionsFromHosts,
  type HostSessionSlices
} from './workspace-session-host-split'

/**
 * Which execution hosts publish each workspace id, and what persistence does when two of them
 * publish the same one.
 *
 * A worktree id is `repoId::path` with no host component, so one repo registered on two hosts
 * publishes the SAME id for two different workspaces (STA-4343). Session state is keyed by that
 * bare id, so without this the two workspaces share one `tabsByWorktree` bucket and whichever host
 * writes last erases the other's tabs for good.
 *
 * The contested id gets one primary host, whose entries keep the normal bare key in the unified
 * renderer session. Every other claimant's entries are parked in a shadow that never reaches
 * renderer state and is written straight back to that host's own partition, so no host's session is
 * destroyed by another's write.
 *
 * The primary is decided ONCE, at read time, from the partition each row actually came from, and
 * that decision is carried back to the write path. Re-deriving it from the catalog at write time
 * would let the two disagree — the catalog names `ssh:*` hosts that own no partition — and the
 * write would then copy one host's workspace into another host's partition.
 *
 * Known gaps: hosts that share a partition cannot be separated at all ('local' and every `ssh:*`
 * host persist into the 'local' blob), and the unified renderer session still holds one bucket per
 * bare id, so both workspaces display the primary's tabs. Closing either needs host-qualified keys
 * through the whole tab store.
 */

export type WorktreeHostClaims = ReadonlyMap<string, ReadonlySet<ExecutionHostId>>

const WORKTREE_KEYED_FIELDS = (
  Object.keys(WORKSPACE_SESSION_FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]
).filter((field) => WORKSPACE_SESSION_FIELD_OWNERSHIP[field] === 'worktreeKeyed')

/** Bare worktree id behind a session key, which may be a WorkspaceKey or a host-qualified identity. */
export function normalizeWorkspaceSessionKeyToWorktreeId(value: string): string {
  if (isWorktreeHostIdentity(value)) {
    return getWorktreeIdFromHostIdentity(value)
  }
  const scope = parseWorkspaceKey(value)
  return scope?.type === 'worktree' ? scope.worktreeId : value
}

function resolveClaimedHostId(
  worktree: WorkspaceRuntimeOwnerProjection,
  repoHostById: ReadonlyMap<string, ExecutionHostId | null>
): ExecutionHostId | null {
  const runtimeOwner = worktree.runtimeOwnerEnvironmentId?.trim()
  if (runtimeOwner) {
    return toRuntimeExecutionHostId(runtimeOwner)
  }
  const parsed = parseExecutionHostId(worktree.hostId)
  if (parsed) {
    return parsed.id
  }
  // Why: an unqualified row is attributable only when its repo id names exactly one host —
  // guessing would invent a contest that is not there, or hide one that is.
  return repoHostById.get(worktree.repoId) ?? null
}

export function indexWorktreeHostClaims(
  worktreesByRepo: Record<string, readonly WorkspaceRuntimeOwnerProjection[]>,
  repoHostById: ReadonlyMap<string, ExecutionHostId | null>
): WorktreeHostClaims {
  const claims = new Map<string, Set<ExecutionHostId>>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      const hostId = resolveClaimedHostId(worktree, repoHostById)
      if (!hostId) {
        continue
      }
      const existing = claims.get(worktree.id)
      if (existing) {
        existing.add(hostId)
      } else {
        claims.set(worktree.id, new Set([hostId]))
      }
    }
  }
  return claims
}

/** The partition a host's session rows live in: a runtime host owns one, while 'local' and every
 *  `ssh:*` host share the 'local' blob. */
export function sessionPartitionHostFor(hostId: ExecutionHostId): ExecutionHostId {
  return parseExecutionHostId(hostId)?.kind === 'runtime' ? hostId : LOCAL_EXECUTION_HOST_ID
}

/** Distinct partitions a set of claimants spans. Fewer than two means persistence cannot tell the
 *  claimants apart, so the id keeps its uncontested routing. */
export function contestedPartitionHosts(claimed: Iterable<ExecutionHostId>): ExecutionHostId[] {
  return [...new Set([...claimed].map(sessionPartitionHostFor))]
}

/** Stable owner of a contested id: 'local' when it is a claimant, else the lowest host id.
 *  Deliberately not the active host — a primary that followed navigation would migrate the same
 *  rows between partitions on every workspace switch. */
export function pickPrimaryHostForClaims(hostIds: Iterable<ExecutionHostId>): ExecutionHostId {
  const sorted = [...hostIds].sort()
  return sorted.includes(LOCAL_EXECUTION_HOST_ID)
    ? LOCAL_EXECUTION_HOST_ID
    : (sorted[0] ?? LOCAL_EXECUTION_HOST_ID)
}

function definedHostIds(slices: HostSessionSlices): ExecutionHostId[] {
  return (Object.keys(slices) as ExecutionHostId[]).filter((hostId) => slices[hostId])
}

function indexHostIdsBySessionKey(
  slices: HostSessionSlices,
  hostIds: readonly ExecutionHostId[]
): Map<string, ExecutionHostId[]> {
  const hostIdsByKey = new Map<string, ExecutionHostId[]>()
  for (const hostId of hostIds) {
    for (const field of WORKTREE_KEYED_FIELDS) {
      const record = slices[hostId]?.[field]
      if (!isWorkspaceSessionRecord(record)) {
        continue
      }
      for (const key of Object.keys(record)) {
        const owners = hostIdsByKey.get(key)
        if (!owners) {
          hostIdsByKey.set(key, [hostId])
        } else if (!owners.includes(hostId)) {
          owners.push(hostId)
        }
      }
    }
  }
  return hostIdsByKey
}

function shadowHostEntries(
  slice: WorkspaceSessionState,
  hostId: ExecutionHostId,
  primaryByKey: ReadonlyMap<string, ExecutionHostId>
): { slice: WorkspaceSessionState; shadow: WorkspaceSessionState | null } {
  let nextSlice: WorkspaceSessionState | null = null
  let shadow: WorkspaceSessionState | null = null
  for (const field of WORKTREE_KEYED_FIELDS) {
    const record = slice[field]
    if (!isWorkspaceSessionRecord(record)) {
      continue
    }
    const kept: WorkspaceSessionRecord = {}
    const parked: WorkspaceSessionRecord = {}
    for (const [key, entry] of Object.entries(record)) {
      const primary = primaryByKey.get(key)
      if (primary && primary !== hostId) {
        parked[key] = entry
      } else {
        kept[key] = entry
      }
    }
    if (Object.keys(parked).length === 0) {
      continue
    }
    nextSlice ??= { ...slice }
    shadow ??= {} as WorkspaceSessionState
    ;(nextSlice as WorkspaceSessionRecord)[field] = kept
    ;(shadow as WorkspaceSessionRecord)[field] = parked
  }
  return { slice: nextSlice ?? slice, shadow }
}

/** Split contested worktree-keyed entries out of the read partitions: the primary host's rows stay
 *  in the slices the renderer merges, every other claimant's rows move to the shadow.
 *
 *  `primaryHostBySessionKey` records where each key's live row came from — including the
 *  uncontested single-partition case, so the write path can put every row back in its own
 *  partition instead of re-deriving an owner that may not match. */
export function extractContestedHostSessionEntries(slices: HostSessionSlices): {
  slices: HostSessionSlices
  shadow: HostSessionSlices
  primaryHostBySessionKey: Record<string, ExecutionHostId>
} {
  const shadow: HostSessionSlices = {}
  const hostIds = definedHostIds(slices)
  const hostIdsByKey = indexHostIdsBySessionKey(slices, hostIds)
  const primaryHostBySessionKey: Record<string, ExecutionHostId> = {}
  for (const [key, owners] of hostIdsByKey) {
    primaryHostBySessionKey[key] = pickPrimaryHostForClaims(owners)
  }
  if (hostIds.length < 2) {
    return { slices, shadow, primaryHostBySessionKey }
  }
  const primaryByKey = new Map<string, ExecutionHostId>()
  for (const [key, owners] of hostIdsByKey) {
    if (owners.length > 1) {
      primaryByKey.set(key, pickPrimaryHostForClaims(owners))
    }
  }
  if (primaryByKey.size === 0) {
    return { slices, shadow, primaryHostBySessionKey }
  }
  const next: HostSessionSlices = { ...slices }
  for (const hostId of hostIds) {
    const slice = slices[hostId]
    if (!slice) {
      continue
    }
    const result = shadowHostEntries(slice, hostId, primaryByKey)
    next[hostId] = result.slice
    if (result.shadow) {
      shadow[hostId] = result.shadow
    }
  }
  return { slices: next, shadow, primaryHostBySessionKey }
}

export function mergeWorkspaceSessionsWithHostShadow(slices: HostSessionSlices): {
  session: WorkspaceSessionState
  slices: HostSessionSlices
  shadow: HostSessionSlices
  primaryHostBySessionKey: Record<string, ExecutionHostId>
} {
  const extracted = extractContestedHostSessionEntries(slices)
  return {
    session: mergeWorkspaceSessionsFromHosts(extracted.slices),
    slices: extracted.slices,
    shadow: extracted.shadow,
    primaryHostBySessionKey: extracted.primaryHostBySessionKey
  }
}

function hostStillClaimsKey(
  claims: WorktreeHostClaims,
  key: string,
  hostId: ExecutionHostId
): boolean {
  const claimed = claims.get(normalizeWorkspaceSessionKeyToWorktreeId(key))
  // Why: a missing catalog row is not evidence the host lost the workspace — the catalog may not
  // have hydrated, or the key may be a folder workspace. Only a positive re-attribution drops a row.
  return !claimed || claimed.has(hostId)
}

/** Whether the slices will be applied as a merge-by-field patch or a full partition replace. */
export type HostSessionWriteMode = 'patch' | 'replace'

/** Write parked entries back into their own host's slice so a write for the primary host cannot
 *  erase a co-claimant's persisted session. Mutates the slices produced by the split. */
export function attachHostSessionShadow(
  slices: HostSessionSlices,
  shadow: HostSessionSlices | undefined,
  claims: WorktreeHostClaims,
  mode: HostSessionWriteMode
): void {
  if (!shadow) {
    return
  }
  for (const [hostId, shadowSlice] of Object.entries(shadow) as [
    ExecutionHostId,
    WorkspaceSessionState | undefined
  ][]) {
    const slice = slices[hostId]
    if (!slice || !shadowSlice) {
      continue
    }
    for (const field of WORKTREE_KEYED_FIELDS) {
      const parked = shadowSlice[field]
      if (!isWorkspaceSessionRecord(parked)) {
        continue
      }
      let target = slice[field]
      if (!isWorkspaceSessionRecord(target)) {
        // Why the mode split: a patch that omits the field leaves the partition's own copy
        // untouched, but a full set erases omitted fields, so the parked rows must ride along.
        if (mode === 'patch') {
          continue
        }
        target = {}
        ;(slice as WorkspaceSessionRecord)[field] = target
      }
      for (const [key, entry] of Object.entries(parked)) {
        if (Object.hasOwn(target, key) || !hostStillClaimsKey(claims, key, hostId)) {
          continue
        }
        target[key] = entry
      }
    }
  }
}
