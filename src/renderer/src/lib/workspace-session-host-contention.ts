import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../shared/workspace-session-host-field-ownership'
import { pickPrimaryHostForClaims } from '../../../shared/workspace-session-contested-primary-host'
import {
  isWorkspaceSessionRecord,
  type WorkspaceSessionRecord
} from '../../../shared/workspace-session-host-records'
import type { WorkspaceRuntimeOwnerProjection } from './workspace-runtime-host-ownership'
import {
  mergeWorkspaceSessionsFromHosts,
  type HostSessionSlices
} from './workspace-session-host-split'

/** Bare workspace IDs collide across hosts (STA-4343). Choose one primary from actual read partitions; park other claimants outside renderer state and write them back unchanged. Preserve that read decision on writes rather than rederive from catalog-only SSH claims. Known gap: unified bare-key renderer state shows primary tabs for both; full repair needs host-qualified tab keys. */

export type WorktreeHostClaims = ReadonlyMap<string, ReadonlySet<ExecutionHostId>>

const WORKTREE_KEYED_FIELDS = (
  Object.keys(WORKSPACE_SESSION_FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]
).filter((field) => WORKSPACE_SESSION_FIELD_OWNERSHIP[field] === 'worktreeKeyed')

/** Share session-key normalization with partition adoption so read and write cannot drift. */
export const normalizeWorkspaceSessionKeyToWorktreeId = normalizeWorkspaceSessionKeyToWorkspaceId

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
  // Attribute unqualified rows only to unique repo owners; guessing invents or hides host contests.
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

/** Keep primary rows in merged slices and park other claimants. Record source partition for every live key, including uncontested ones, so write returns it there; contestedSessionKeys alone identifies collisions. */
export function extractContestedHostSessionEntries(slices: HostSessionSlices): {
  slices: HostSessionSlices
  shadow: HostSessionSlices
  primaryHostBySessionKey: Record<string, ExecutionHostId>
  contestedSessionKeys: Set<string>
} {
  const shadow: HostSessionSlices = {}
  const hostIds = definedHostIds(slices)
  const hostIdsByKey = indexHostIdsBySessionKey(slices, hostIds)
  const primaryHostBySessionKey: Record<string, ExecutionHostId> = {}
  const contestedSessionKeys = new Set<string>()
  for (const [key, owners] of hostIdsByKey) {
    primaryHostBySessionKey[key] = pickPrimaryHostForClaims(owners)
    if (owners.length > 1) {
      contestedSessionKeys.add(key)
    }
  }
  if (hostIds.length < 2) {
    return { slices, shadow, primaryHostBySessionKey, contestedSessionKeys }
  }
  const primaryByKey = new Map<string, ExecutionHostId>()
  for (const [key, owners] of hostIdsByKey) {
    if (owners.length > 1) {
      primaryByKey.set(key, pickPrimaryHostForClaims(owners))
    }
  }
  if (primaryByKey.size === 0) {
    return { slices, shadow, primaryHostBySessionKey, contestedSessionKeys }
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
  return { slices: next, shadow, primaryHostBySessionKey, contestedSessionKeys }
}

export function mergeWorkspaceSessionsWithHostShadow(slices: HostSessionSlices): {
  session: WorkspaceSessionState
  slices: HostSessionSlices
  shadow: HostSessionSlices
  primaryHostBySessionKey: Record<string, ExecutionHostId>
  contestedSessionKeys: Set<string>
} {
  const extracted = extractContestedHostSessionEntries(slices)
  return {
    session: mergeWorkspaceSessionsFromHosts(extracted.slices),
    slices: extracted.slices,
    shadow: extracted.shadow,
    primaryHostBySessionKey: extracted.primaryHostBySessionKey,
    contestedSessionKeys: extracted.contestedSessionKeys
  }
}

function hostStillClaimsKey(
  claims: WorktreeHostClaims,
  key: string,
  hostId: ExecutionHostId
): boolean {
  const claimed = claims.get(normalizeWorkspaceSessionKeyToWorktreeId(key))
  // Missing/unhydrated/folder catalog rows prove no ownership loss; drop only on positive reattribution.
  return !claimed || claimed.has(hostId)
}

/** Whether the slices will be applied as a merge-by-field patch or a full partition replace. */
export type HostSessionWriteMode = 'patch' | 'replace'

/** Restore parked co-claimant rows to their own split slices before writing so primary updates cannot erase them. */
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
        // Omitted patch fields remain untouched, but full partition replacement erases them; include parked fields for full writes.
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
