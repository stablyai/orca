const EMPTY_MEMBERSHIP: ReadonlySet<string> = new Set()
let sources: readonly ReadonlySet<string>[] = []
let combined = EMPTY_MEMBERSHIP

export function reuseWorktreeMembership(
  previous: ReadonlySet<string> | undefined,
  ids: Iterable<string>
): ReadonlySet<string> {
  const next = new Set(ids)
  if (!previous || previous.size !== next.size) {
    return next
  }
  for (const id of next) {
    if (!previous.has(id)) {
      return next
    }
  }
  return previous
}

export function combineWorktreeAgentRowMembership(
  terminal: ReadonlySet<string>,
  live: ReadonlySet<string>,
  migration: ReadonlySet<string>,
  retained: ReadonlySet<string>
): ReadonlySet<string> {
  if (
    sources[0] === terminal &&
    sources[1] === live &&
    sources[2] === migration &&
    sources[3] === retained
  ) {
    return combined
  }
  sources = [terminal, live, migration, retained]
  const union = new Set<string>()
  for (const ids of sources) {
    for (const id of ids) {
      union.add(id)
    }
  }
  combined = reuseWorktreeMembership(combined, union)
  return combined
}
