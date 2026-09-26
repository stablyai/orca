/**
 * The execution host's ordering stamp for one repo's worktree catalog.
 *
 * Every catalog publication a host sends (a listing, a create reply, a remove reply) says which
 * catalog it describes. A listing is a snapshot from when its scan began; a mutation reply names
 * the catalog its mutation produced. A client applies publications in that order and never lets
 * an older snapshot undo a newer fact, whatever order they arrived in.
 *
 * `sequence` is the host's per-repo scan generation, which every worktree change bumps. It lives
 * in one process, so `epoch` names that process: numbers from a restarted host restart, and a
 * different epoch is a new catalog rather than an older one.
 */
export type WorktreeCatalogVersion = Readonly<{
  epoch: string
  sequence: number
}>

export function isWorktreeCatalogVersion(value: unknown): value is WorktreeCatalogVersion {
  return (
    typeof value === 'object' &&
    value !== null &&
    'epoch' in value &&
    typeof value.epoch === 'string' &&
    'sequence' in value &&
    typeof value.sequence === 'number' &&
    Number.isFinite(value.sequence)
  )
}

/** True when `candidate` describes the catalog as it stood before `applied`, on the same host. */
export function isWorktreeCatalogVersionBefore(
  candidate: WorktreeCatalogVersion,
  applied: WorktreeCatalogVersion
): boolean {
  return candidate.epoch === applied.epoch && candidate.sequence < applied.sequence
}

/** The version a client should hold after applying `incoming` on top of `applied`. */
export function laterWorktreeCatalogVersion(
  applied: WorktreeCatalogVersion | undefined,
  incoming: WorktreeCatalogVersion
): WorktreeCatalogVersion {
  if (!applied || applied.epoch !== incoming.epoch) {
    return incoming
  }
  // Why strict: an equal version keeps the held object, so a no-op listing patches no state.
  return incoming.sequence > applied.sequence ? incoming : applied
}
