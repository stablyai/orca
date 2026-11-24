type FoldChange = { token: symbol; from?: symbol; keys?: readonly string[] }
const changes = new WeakMap<ReadonlySet<string>, FoldChange>()

/** Provenance without retaining earlier fold sets; unknown replacements still recount. */
export function recordCollapsedGroupChanges(
  previous: ReadonlySet<string>,
  next: Set<string>,
  keys: Iterable<string>
): Set<string> {
  if (next === previous) {
    return next
  }
  const changed = new Set<string>()
  for (const key of keys) {
    if (previous.has(key) !== next.has(key)) {
      changed.add(key)
    }
  }
  const from = changes.get(previous) ?? { token: Symbol() }
  changes.set(previous, from)
  changes.set(next, { token: Symbol(), from: from.token, keys: [...changed] })
  return next
}

export function toggleCollapsedGroupSet(previous: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(previous)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  return recordCollapsedGroupChanges(previous, next, [key])
}

export function changedCollapsedGroupKeys(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>
): readonly string[] | undefined {
  const change = changes.get(next)
  return change?.from === changes.get(previous)?.token ? change?.keys : undefined
}
