/**
 * The bounded per-environment list behind a durable close intent: closes this client owes a
 * runtime environment, newest last. Each owner supplies the identity of one close and its bounds.
 */
export type EnvironmentCloseIntentList<T extends { closedAt: number }> = {
  keyOf: (intent: T) => string
  maxPerEnvironment: number
  maxAgeMs: number
}

/** Appends closes not already held, dropping the oldest past the cap. Returns null if unchanged. */
export function appendEnvironmentCloseIntents<T extends { closedAt: number }>(
  list: EnvironmentCloseIntentList<T>,
  current: Record<string, T[]>,
  additions: readonly { environmentId: string; intent: T }[]
): Record<string, T[]> | null {
  const next = { ...current }
  let changed = false
  for (const { environmentId, intent } of additions) {
    const existing = next[environmentId] ?? []
    const key = list.keyOf(intent)
    if (existing.some((held) => list.keyOf(held) === key)) {
      continue
    }
    next[environmentId] = [...existing, intent].slice(-list.maxPerEnvironment)
    changed = true
  }
  return changed ? next : null
}

/** Drops the named closes plus anything older than the give-up bound. Returns null if unchanged. */
export function removeEnvironmentCloseIntents<T extends { closedAt: number }>(
  list: EnvironmentCloseIntentList<T>,
  current: Record<string, T[]>,
  args: { environmentId: string; keys: readonly string[]; now: number }
): Record<string, T[]> | null {
  const existing = current[args.environmentId]
  if (!existing) {
    return null
  }
  const cleared = new Set(args.keys)
  const remaining = existing.filter(
    (intent) => !cleared.has(list.keyOf(intent)) && args.now - intent.closedAt <= list.maxAgeMs
  )
  if (remaining.length === existing.length) {
    return null
  }
  const next = { ...current }
  if (remaining.length === 0) {
    delete next[args.environmentId]
  } else {
    next[args.environmentId] = remaining
  }
  return next
}
