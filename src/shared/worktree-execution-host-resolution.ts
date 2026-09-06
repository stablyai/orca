/**
 * One rule for "which host does this worktree execute on, and what connection routes there".
 *
 * Main and the renderer both have to answer it — the terminal launch scope picks a PTY route from
 * it, the renderer picks a file-read route and the reconnect affordance from it — so the rule lives
 * here instead of being re-derived per side. Two re-derivations already disagreed: main answered
 * from the worktree's own host while the renderer fell back to an id-only repo lookup, so a pane on
 * `ssh:m4air` was offered "Reconnect openclaw" and read its files off openclaw (#11163).
 *
 * `unresolved` is a distinct answer, never "local": the same repo id can exist on a local, an SSH
 * and a runtime host at once, and loss of a usable answer must fail closed rather than authorize a
 * client-side read of a remote path (#6648, #17799).
 */

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

/**
 * How a caller finds repo rows. Main scans the store array; the renderer answers from a
 * WeakMap-memoized index because owner resolution runs inside retained selectors. That is a
 * performance difference, not a different rule.
 */
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
      /**
       * The SSH target whose filesystem holds this workspace — for a `runtime:` host, its nested
       * target, addressable only as the pair with `hostId`. Callers deciding what *this client*
       * may dial (a PTY route, a Git provider) must use `getSshTargetIdForExecutionHost(hostId)`
       * instead; this field can name a host the client cannot reach on its own.
       */
      connectionId: string | null
      /** Display metadata only. The decisions are `hostId` / `connectionId`. */
      owner: T | null
    }
  /**
   * Three reasons, not two, and deliberately not collapsed. `unknown` (nothing carries the id) is a
   * verdict the launch path may legitimately dispose of as a plain local folder; `malformed` (the
   * row named a host that cannot be parsed) must fail closed. A vocabulary that cannot express the
   * difference guarantees it is lost at the first caller that switches on it — the same shape as
   * #18006, where one word had to stand for two liveness situations.
   */
  | { kind: 'unresolved'; reason: 'ambiguous' | 'unknown' | 'malformed' }

/**
 * The owner row's host, or `null` when the row names one that cannot be parsed.
 *
 * Module-private and deliberately not a second exported reading of a repo row: only this resolution
 * needs the distinction, because only this resolution is routing. `getRepoExecutionHostId` stays the
 * answer everywhere else — its fall-through to `local` is harmless for the grouping, label and index
 * callers that make up nearly all of its ~340 call sites, and is wrong only when the value decides
 * where work runs.
 */
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
    // The worktree names its own host, which outranks every repo row. A row on a *different* host
    // is not evidence about this one — falling back to it is the cross-host leak: one SSH host's
    // pane routed to another. A row on *this* host still is evidence, and is the only place a
    // runtime's nested SSH target appears.
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

/**
 * Array-backed lookup for callers holding the whole repo list (main's store). Grouped once at
 * construction — a lookup is hit once per worktree key per target, so a per-call `filter` was an
 * O(repos) rescan each time. Rows keep repo-list order, which `byId` depends on for `rows[0]`.
 */
export function createRepoRowExecutionHostLookup<T extends ExecutionHostOwnerRow>(
  repos: readonly T[]
): ExecutionHostOwnerLookup<T> {
  const rowsById = new Map<string, T[]>()
  for (const repo of repos) {
    const rows = rowsById.get(repo.id)
    if (rows) {
      rows.push(repo)
    } else {
      rowsById.set(repo.id, [repo])
    }
  }
  const rowsFor = (repoId: string): readonly T[] => rowsById.get(repoId) ?? EMPTY_ROWS
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
    // A row naming an unparseable host matches no host, which is what stops a worktree on a real
    // host from adopting it.
    byHost: (repoId, hostId) =>
      rowsFor(repoId).find((repo) => resolveOwnerRowHostId(repo) === hostId) ?? null
  }
}
