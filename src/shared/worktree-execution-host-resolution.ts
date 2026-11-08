/** Share main/renderer routing so a repo ID present on multiple hosts cannot send PTYs, file reads or reconnects to a sibling host (#11163, #6648, #17799).
 * Unresolved ownership never authorizes a local read of a remote path; callers must handle each reason. */

import type { Repo } from './repo-types'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  getSshTargetIdForExecutionHost,
  normalizeExecutionHostId,
  type ExecutionHostId
} from './execution-host'

export type ExecutionHostOwnerRow = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

export type ExecutionHostOwnerMatch<T> =
  | { kind: 'resolved'; owner: T }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

/** Main scans store rows; retained renderer selectors use a memoized index. Both implement the same ownership rule. */
export type ExecutionHostOwnerLookup<T extends ExecutionHostOwnerRow> = {
  /** The row for `repoId`, or `ambiguous` when rival rows disagree about the owning host. */
  byId: (repoId: string) => ExecutionHostOwnerMatch<T>
  /** The row for `repoId` on exactly `hostId`, or null when that host carries no row. */
  byHost: (repoId: string, hostId: ExecutionHostId) => T | null
}

export type WorktreeExecutionHostResolution<T extends ExecutionHostOwnerRow> =
  | {
      kind: 'resolved'
      hostId: ExecutionHostId
      /** Filesystem SSH target, paired with hostId for nested runtime targets. Client dialers must instead use getSshTargetIdForExecutionHost(hostId); this target may be unreachable directly. */
      connectionId: string | null
      /** Display metadata only. The decisions are `hostId` / `connectionId`. */
      owner: T | null
    }
  /** Unknown may mean a plain local folder. Malformed means a row declared an unparseable host and must fail closed; ambiguity also cannot authorize routing. */
  | { kind: 'unresolved'; reason: 'ambiguous' | 'unknown' | 'malformed' }

/** Routing must reject malformed declared hosts. getRepoExecutionHostId’s local fallback remains suitable for non-routing grouping/label callers. */
function resolveOwnerRowHostId(row: ExecutionHostOwnerRow): ExecutionHostId | null {
  return row.executionHostId?.trim()
    ? normalizeExecutionHostId(row.executionHostId)
    : getRepoExecutionHostId(row)
}

export function resolveWorktreeExecutionHost<T extends ExecutionHostOwnerRow>(
  lookup: ExecutionHostOwnerLookup<T>,
  worktree: { repoId: string; hostId?: string | null }
): WorktreeExecutionHostResolution<T> {
  const worktreeHostId = normalizeExecutionHostId(worktree.hostId)
  if (worktreeHostId) {
    // An explicit worktree host outranks repo rows. Only its same-host row can supply a runtime’s nested SSH target.
    const owner = lookup.byHost(worktree.repoId, worktreeHostId)
    return {
      kind: 'resolved',
      hostId: worktreeHostId,
      connectionId:
        getSshTargetIdForExecutionHost(worktreeHostId) ??
        (owner ? getRepoSshConnectionId(owner) : null),
      owner
    }
  }
  const match = lookup.byId(worktree.repoId)
  if (match.kind !== 'resolved') {
    return { kind: 'unresolved', reason: match.kind === 'ambiguous' ? 'ambiguous' : 'unknown' }
  }
  const hostId = resolveOwnerRowHostId(match.owner)
  if (!hostId) {
    return { kind: 'unresolved', reason: 'malformed' }
  }
  return {
    kind: 'resolved',
    hostId,
    connectionId: getRepoSshConnectionId(match.owner),
    owner: match.owner
  }
}

const EMPTY_ROWS: readonly never[] = []

/** Group once to avoid O(repos) scans per worktree/target. Retain repo-list order because byId chooses the first agreeing row. */
export function createRepoRowExecutionHostLookup<T extends ExecutionHostOwnerRow>(
  repos: readonly T[]
): ExecutionHostOwnerLookup<T> {
  const rowsById = new Map<string, T[]>()
  for (const repo of repos) {
    const repoId = repo.id
    const rows = rowsById.get(repoId)
    if (rows) {
      rows.push(repo)
    } else {
      rowsById.set(repoId, [repo])
    }
  }
  const rowsFor = (repoId: string): readonly T[] => rowsById.get(repoId) ?? EMPTY_ROWS
  return createRepoExecutionHostLookup(rowsFor)
}

/** Reuse an existing complete repo index without changing execution-host matching semantics. */
export function createRepoExecutionHostLookup<T extends ExecutionHostOwnerRow>(
  rowsFor: (repoId: string) => readonly T[]
): ExecutionHostOwnerLookup<T> {
  return {
    byId: (repoId) => {
      const rows = rowsFor(repoId)
      const owner = rows[0]
      if (!owner) {
        return { kind: 'missing' }
      }
      const ownerHostId = resolveOwnerRowHostId(owner)
      return rows.some((repo) => resolveOwnerRowHostId(repo) !== ownerHostId)
        ? { kind: 'ambiguous' }
        : { kind: 'resolved', owner }
    },
    // Malformed declared hosts must never match a real host.
    byHost: (repoId, hostId) =>
      rowsFor(repoId).find((repo) => resolveOwnerRowHostId(repo) === hostId) ?? null
  }
}
