import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../shared/worktree/types'

/** The persisted focus-recency map is host-qualified for new writes. */
export type WorktreeVisitOwner = Pick<Worktree, 'id' | 'hostId'>

/**
 * Read recency for one visible row.
 *
 * The bare lookup is deliberately second: it keeps sessions written before
 * host-qualified recency useful without letting a legacy value override a
 * newer host-specific visit.
 */
export function getWorktreeVisitTimestamp(
  timestamps: Readonly<Record<string, number>> | undefined,
  worktree: WorktreeVisitOwner
): number | undefined {
  if (!timestamps) {
    return undefined
  }
  const qualified = timestamps[getWorktreeHostIdentity(worktree)]
  return qualified ?? timestamps[worktree.id]
}

/**
 * Key used for a newly stamped visit. Unknown-host rows keep the legacy bare
 * key because there is no safe host qualification to persist; once a row has
 * host evidence, all new writes use the canonical `${host}|${id}` form.
 */
export function getWorktreeVisitKey(worktreeId: string, hostId?: ExecutionHostId): string {
  return hostId ? composeWorktreeHostIdentity(hostId, worktreeId) : worktreeId
}

/**
 * Decode only keys that use the canonical host-qualified shape. Bare legacy
 * ids are returned unchanged, including ids that happen to contain `|`.
 */
export function getWorktreeIdFromVisitKey(key: string): string {
  const separator = key.indexOf('|')
  if (separator === -1) {
    return key
  }
  // Empty host is the canonical unknown-host bucket. Known host ids are the
  // other valid prefixes; a legacy worktree id may itself contain `|`.
  if (isWorktreeHostIdentity(key)) {
    return getWorktreeIdFromHostIdentity(key)
  }
  return key
}

export function isHostQualifiedVisitKey(key: string): boolean {
  return getWorktreeIdFromVisitKey(key) !== key
}

/** Remove all recency entries belonging to one or more raw worktree ids. */
export function removeWorktreeVisitEntries(
  timestamps: Readonly<Record<string, number>>,
  worktreeIds: ReadonlySet<string>,
  hostId?: ExecutionHostId
): Record<string, number> {
  return removeWorktreeVisitEntriesForTargets(
    timestamps,
    [...worktreeIds].map((id) => ({ id, hostId }))
  )
}

/**
 * Remove recency for bulk purge targets. A host-qualified target only removes
 * that host's key; an unknown-host target deliberately retains the legacy
 * raw-id behavior because no owner can safely be inferred.
 */
export function removeWorktreeVisitEntriesForTargets(
  timestamps: Readonly<Record<string, number>>,
  targets: readonly WorktreeVisitOwner[]
): Record<string, number> {
  let changed = false
  const next: Record<string, number> = {}
  const qualified = new Set<string>()
  const legacyIds = new Set<string>()
  for (const target of targets) {
    if (target.hostId) {
      qualified.add(getWorktreeVisitKey(target.id, target.hostId))
    } else {
      legacyIds.add(target.id)
    }
  }
  for (const [key, timestamp] of Object.entries(timestamps)) {
    const rawId = getWorktreeIdFromVisitKey(key)
    const remove = qualified.has(key) || legacyIds.has(rawId)
    if (remove) {
      changed = true
      continue
    }
    next[key] = timestamp
  }
  return changed ? next : (timestamps as Record<string, number>)
}
