import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getProjectGroupHostId } from '../../../../store/slices/project-group-owner-routing'

/** One sidebar row's worth of project group: the copy that owns the row plus
 *  every same-identity copy from another host folded into it. */
export type MergedProjectGroup = {
  primary: ProjectGroup
  members: readonly ProjectGroup[]
  /** What the sidebar keys its header, buckets and collapse state on: the primary's
   *  id, host-qualified only when a second merged row's primary reuses that id.
   *  Ownership and mutations keep routing through `primary`, never through this. */
  rowId: string
}

/** Merged rows plus the lookups that map a raw (host, id) pair back onto one. */
export type MergedProjectGroupIndex = {
  merged: readonly MergedProjectGroup[]
  byHostScopedKey: ReadonlyMap<string, MergedProjectGroup>
  /** Id-only fallback for callers with no host in hand. A null value marks an id
   *  that two hosts reuse for different merged rows, where guessing would be wrong. */
  byAmbiguousId: ReadonlyMap<string, MergedProjectGroup | null>
  byRowId: ReadonlyMap<string, MergedProjectGroup>
}

/** Raw (host, id) lookup over the unmerged groups, for walks up a parent chain:
 *  parentGroupId is per-host, so a bare-id map can cross to another host's group. */
export type ProjectGroupHostIndex = {
  byHostScopedKey: ReadonlyMap<string, ProjectGroup>
  byAmbiguousId: ReadonlyMap<string, ProjectGroup | null>
}

function getHostScopedKey(group: ProjectGroup): string {
  return toHostScopedKey(getProjectGroupHostId(group), group.id)
}

export function toHostScopedKey(hostId: string, groupId: string): string {
  return `${hostId}\u0000${groupId}`
}

/**
 * Identity shared by the copies of one logical group across hosts: the chain of
 * normalized names up to the root. Ids and parentPath are per-host, names are not.
 *
 * Segments are length-prefixed rather than delimiter-joined because a folder-scan
 * group's name is a relative path and may itself contain the delimiter, which would
 * make `packages/shared` and `shared` under `packages` collide.
 */
function getCrossHostIdentity(
  group: ProjectGroup,
  byHostScopedKey: ReadonlyMap<string, ProjectGroup>,
  cache: Map<string, string>,
  resolving: Set<string>
): string {
  const key = getHostScopedKey(group)
  const cached = cache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const name = group.name.trim().toLowerCase()
  // Why: a cyclic parent chain would recurse forever; fall back to the row's own id.
  if (resolving.has(key)) {
    return `\u0001cycle\u0001${key.length}:${key}`
  }
  resolving.add(key)
  const parent = group.parentGroupId
    ? byHostScopedKey.get(toHostScopedKey(getProjectGroupHostId(group), group.parentGroupId))
    : undefined
  const parentIdentity = parent
    ? getCrossHostIdentity(parent, byHostScopedKey, cache, resolving)
    : ''
  resolving.delete(key)
  const identity = `${parentIdentity}${name.length}:${name}`
  cache.set(key, identity)
  return identity
}

/** The local copy owns the row when there is one: its id keys collapse state and
 *  its host is where menu actions land without a round trip. */
function isPreferredPrimary(candidate: ProjectGroup, current: ProjectGroup): boolean {
  const candidateIsLocal = getProjectGroupHostId(candidate) === LOCAL_EXECUTION_HOST_ID
  const currentIsLocal = getProjectGroupHostId(current) === LOCAL_EXECUTION_HOST_ID
  if (candidateIsLocal !== currentIsLocal) {
    return candidateIsLocal
  }
  if (candidate.createdAt !== current.createdAt) {
    return candidate.createdAt < current.createdAt
  }
  return candidate.id < current.id
}

/**
 * Fold the per-host copies of one logical project group into a single row.
 *
 * Projects already merge across hosts (one row carrying a local and a paired-host
 * checkout), but their groups did not: the copy that lost the project rows stayed
 * behind as an identical, unfoldable header (#22022).
 *
 * Only copies on *different* hosts fold together. Two same-named siblings on one
 * host are two real groups the user can tell apart and move projects between, so
 * an identity any single host claims twice is left entirely unmerged.
 */
type MergedProjectGroupRow = Omit<MergedProjectGroup, 'rowId'>

/** A row id must survive two hosts reusing one group id for unrelated rows: both
 *  primaries would otherwise render under the same header key and share a bucket. */
function withMergedRowIds(rows: readonly MergedProjectGroupRow[]): MergedProjectGroup[] {
  const primaryIdCounts = new Map<string, number>()
  for (const row of rows) {
    primaryIdCounts.set(row.primary.id, (primaryIdCounts.get(row.primary.id) ?? 0) + 1)
  }
  return rows.map((row) => ({
    ...row,
    rowId:
      (primaryIdCounts.get(row.primary.id) ?? 0) > 1
        ? getHostScopedKey(row.primary)
        : row.primary.id
  }))
}

export function mergeProjectGroupsAcrossHosts(
  projectGroups: readonly ProjectGroup[]
): MergedProjectGroup[] {
  const byHostScopedKey = new Map(projectGroups.map((group) => [getHostScopedKey(group), group]))
  const identityCache = new Map<string, string>()
  const membersByIdentity = new Map<string, ProjectGroup[]>()
  const identityOrder: string[] = []
  for (const group of projectGroups) {
    const identity = getCrossHostIdentity(group, byHostScopedKey, identityCache, new Set())
    const members = membersByIdentity.get(identity)
    if (members) {
      members.push(group)
      continue
    }
    membersByIdentity.set(identity, [group])
    identityOrder.push(identity)
  }

  const merged: MergedProjectGroupRow[] = []
  for (const identity of identityOrder) {
    const members = membersByIdentity.get(identity) ?? []
    const hostIds = new Set<ExecutionHostId>()
    const claimedTwiceByOneHost = members.some((member) => {
      const hostId = getProjectGroupHostId(member)
      if (hostIds.has(hostId)) {
        return true
      }
      hostIds.add(hostId)
      return false
    })
    if (claimedTwiceByOneHost) {
      for (const member of members) {
        merged.push({ primary: member, members: [member] })
      }
      continue
    }
    let primary = members[0]
    for (const member of members) {
      if (isPreferredPrimary(member, primary)) {
        primary = member
      }
    }
    merged.push({ primary, members })
  }
  return withMergedRowIds(merged)
}

const mergedIndexCache = new WeakMap<object, MergedProjectGroupIndex>()

/** Memoized on the project-group array identity, the way the sidebar already
 *  memoizes its project grouping index. */
export function buildMergedProjectGroupIndex(
  projectGroups: readonly ProjectGroup[]
): MergedProjectGroupIndex {
  const cached = mergedIndexCache.get(projectGroups)
  if (cached) {
    return cached
  }
  const merged = mergeProjectGroupsAcrossHosts(projectGroups)
  const byHostScopedKey = new Map<string, MergedProjectGroup>()
  const byAmbiguousId = new Map<string, MergedProjectGroup | null>()
  const byRowId = new Map<string, MergedProjectGroup>()
  for (const entry of merged) {
    byRowId.set(entry.rowId, entry)
    for (const member of entry.members) {
      byHostScopedKey.set(getHostScopedKey(member), entry)
      const seen = byAmbiguousId.get(member.id)
      if (seen === undefined) {
        byAmbiguousId.set(member.id, entry)
      } else if (seen !== entry) {
        // Why: two hosts reusing one group id for different rows — no id-only answer is right.
        byAmbiguousId.set(member.id, null)
      }
    }
  }
  const index = { merged, byHostScopedKey, byAmbiguousId, byRowId }
  mergedIndexCache.set(projectGroups, index)
  return index
}

/** The merged row a raw group id belongs to. Pass the owning host whenever it is
 *  known: ids are only unique per host. */
export function findMergedProjectGroup(
  index: MergedProjectGroupIndex,
  groupId: string,
  hostId?: ExecutionHostId
): MergedProjectGroup | undefined {
  // Why no id-only fallback here: a host-scoped miss means the *owning* host's copy
  // is not indexed, and another host's same-id group is a different group entirely.
  if (hostId !== undefined) {
    return index.byHostScopedKey.get(toHostScopedKey(hostId, groupId))
  }
  return index.byAmbiguousId.get(groupId) ?? undefined
}

/** Raw group id -> the row id the sidebar keys its header and collapse state on.
 *  Falls back to the raw id so callers stay correct for ids the index never saw. */
export function resolveMergedProjectGroupId(
  index: MergedProjectGroupIndex,
  groupId: string,
  hostId?: ExecutionHostId
): string {
  return findMergedProjectGroup(index, groupId, hostId)?.rowId ?? groupId
}

/** The merged row behind a rendered row key, which carries no host of its own. */
export function findMergedProjectGroupByRowId(
  index: MergedProjectGroupIndex,
  rowId: string
): MergedProjectGroup | undefined {
  return index.byRowId.get(rowId)
}

const hostIndexCache = new WeakMap<object, ProjectGroupHostIndex>()

/** Memoized on the project-group array identity, like the merged index above. */
export function buildProjectGroupHostIndex(
  projectGroups: readonly ProjectGroup[]
): ProjectGroupHostIndex {
  const cached = hostIndexCache.get(projectGroups)
  if (cached) {
    return cached
  }
  const byHostScopedKey = new Map<string, ProjectGroup>()
  const byAmbiguousId = new Map<string, ProjectGroup | null>()
  for (const group of projectGroups) {
    byHostScopedKey.set(getHostScopedKey(group), group)
    const seen = byAmbiguousId.get(group.id)
    if (seen === undefined) {
      byAmbiguousId.set(group.id, group)
    } else if (seen !== group) {
      byAmbiguousId.set(group.id, null)
    }
  }
  const index = { byHostScopedKey, byAmbiguousId }
  hostIndexCache.set(projectGroups, index)
  return index
}

/** Same host rule as findMergedProjectGroup: a known host never falls back to an id. */
export function findProjectGroupByHost(
  index: ProjectGroupHostIndex,
  groupId: string,
  hostId?: ExecutionHostId
): ProjectGroup | undefined {
  if (hostId !== undefined) {
    return index.byHostScopedKey.get(toHostScopedKey(hostId, groupId))
  }
  return index.byAmbiguousId.get(groupId) ?? undefined
}
