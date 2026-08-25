import type { ExecutionHostId } from '../execution-host'
import type { Worktree } from './types'

/**
 * Separator between the host and the workspace id.
 *
 * Printable on purpose: these identities become React keys and DOM attribute
 * values, and HTML attribute parsing replaces U+0000 with U+FFFD — a NUL
 * separator would not survive the round trip an anchor comparison depends on.
 *
 * `|` is safe as a delimiter because an execution host id cannot contain one:
 * it is `local`, or a fixed `ssh:`/`runtime:` prefix followed by an
 * `encodeURIComponent`-escaped part (see `toSshExecutionHostId`), which encodes
 * `|` as `%7C`. Putting the host first therefore makes the split unambiguous
 * even though the workspace id — a repo id and a filesystem path — may contain
 * anything.
 */
const HOST_SEPARATOR = '|'

/**
 * Stable key for one workspace on one host (STA-4343).
 *
 * `worktreeId` is `repoId::path` with no host component, so a repo registered on
 * two execution hosts publishes the same id twice for two different workspaces.
 * Any map, set or React key that must keep them apart keys on this instead.
 *
 * An unqualified row gets its own bucket rather than being folded into a host:
 * it may well BE one of them, but nothing here can prove which.
 */
export function getWorktreeHostIdentity(worktree: Pick<Worktree, 'id' | 'hostId'>): string {
  return composeWorktreeHostIdentity(worktree.hostId, worktree.id)
}

export function composeWorktreeHostIdentity(
  hostId: ExecutionHostId | undefined,
  worktreeId: string
): string {
  return `${hostId ?? ''}${HOST_SEPARATOR}${worktreeId}`
}

/**
 * The workspace id back out of an identity.
 *
 * Exact, not best-effort: the host cannot contain the separator (see above), so
 * everything after the first one is the id. That lets an index recover the id
 * from its own key instead of re-reading `worktree.id`, which matters because
 * retained selectors assert that getter is read exactly once per snapshot.
 */
export function getWorktreeIdFromHostIdentity(identity: string): string {
  return identity.slice(identity.indexOf(HOST_SEPARATOR) + 1)
}
