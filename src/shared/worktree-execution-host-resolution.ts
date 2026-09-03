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
  | { kind: 'unresolved'; reason: 'ambiguous' | 'unknown' }

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
  return {
    kind: 'resolved',
    hostId: getRepoExecutionHostId(match.owner),
    connectionId: getRepoSshConnectionId(match.owner),
    owner: match.owner
  }
}

/** Array-backed lookup for callers holding the whole repo list (main's store). */
export function createRepoRowExecutionHostLookup<T extends ExecutionHostOwnerRow>(
  repos: readonly T[]
): ExecutionHostOwnerLookup<T> {
  const rowsFor = (repoId: string): T[] => repos.filter((repo) => repo.id === repoId)
  return {
    byId: (repoId) => {
      const rows = rowsFor(repoId)
      if (rows.length === 0) {
        return { kind: 'missing' }
      }
      const hostIds = new Set(rows.map((repo) => getRepoExecutionHostId(repo)))
      const owner = rows[0]
      return hostIds.size > 1 || !owner ? { kind: 'ambiguous' } : { kind: 'resolved', owner }
    },
    byHost: (repoId, hostId) =>
      rowsFor(repoId).find((repo) => getRepoExecutionHostId(repo) === hostId) ?? null
  }
}
