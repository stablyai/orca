/**
 * The bounded per-environment list behind a durable close intent: closes this client owes a
 * runtime environment, newest last. Each owner supplies the identity of one close and its bounds.
 */
export type EnvironmentCloseIntentList<T extends { closedAt: number }> = {
  keyOf: (intent: T) => string
  maxPerEnvironment: number
  maxAgeMs: number
}

export type EnvironmentCloseIntentEdit<T> = {
  read(environmentId: string): T[] | undefined
  set(environmentId: string, intents: T[]): void
  remove(environmentId: string): void
}

/** Appends closes not already held, dropping the oldest past the cap. */
export function appendEnvironmentCloseIntents<T extends { closedAt: number }>(
  list: EnvironmentCloseIntentList<T>,
  edit: EnvironmentCloseIntentEdit<T>,
  additions: readonly { environmentId: string; intent: T }[]
): boolean {
  let changed = false
  for (const { environmentId, intent } of additions) {
    const existing = edit.read(environmentId) ?? []
    const key = list.keyOf(intent)
    if (existing.some((held) => list.keyOf(held) === key)) {
      continue
    }
    edit.set(environmentId, [...existing, intent].slice(-list.maxPerEnvironment))
    changed = true
  }
  return changed
}

/** Drops the named closes plus anything older than the give-up bound. */
export function removeEnvironmentCloseIntents<T extends { closedAt: number }>(
  list: EnvironmentCloseIntentList<T>,
  edit: EnvironmentCloseIntentEdit<T>,
  args: { environmentId: string; keys: readonly string[]; now: number }
): boolean {
  const existing = edit.read(args.environmentId)
  if (!existing) {
    return false
  }
  const cleared = new Set(args.keys)
  const remaining = existing.filter(
    (intent) => !cleared.has(list.keyOf(intent)) && args.now - intent.closedAt <= list.maxAgeMs
  )
  if (remaining.length === existing.length) {
    return false
  }
  if (remaining.length === 0) {
    edit.remove(args.environmentId)
  } else {
    edit.set(args.environmentId, remaining)
  }
  return true
}
