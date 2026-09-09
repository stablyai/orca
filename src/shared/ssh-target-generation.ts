/**
 * Monotonic allocation of SSH target *registration* generations.
 *
 * A generation identifies one registration incarnation of a target ID: it
 * advances when a target is created, deleted and re-created, or explicitly
 * re-adopted. Connect, reconnect, and status transitions never advance it —
 * that is `SshConnectionState.connectionGeneration`, a different counter.
 *
 * The persisted counter is the *highest generation ever issued*. On load it is
 * reloaded as a high-water mark over the counter, every stored target, and
 * every generation an automation already captured, so a counter lost to a
 * rollback can never reissue a generation an automation is still fenced on.
 */

export const FIRST_SSH_TARGET_GENERATION = 1

/** Accept only values that could have been issued; anything else is treated as absent. */
export function sanitizeSshTargetGeneration(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= FIRST_SSH_TARGET_GENERATION
    ? value
    : undefined
}

export type SshTargetGenerationHighWaterInput = {
  /** Highest generation the persisted counter claims to have issued. */
  persistedCounter?: number | null
  /** Generations stamped on stored SSH targets. */
  targetGenerations: Iterable<number | null | undefined>
  /** Generations captured by stored automations — the reason a rollback cannot be trusted. */
  capturedGenerations: Iterable<number | null | undefined>
}

function highest(values: Iterable<number | null | undefined>, seed: number): number {
  let result = seed
  for (const value of values) {
    const sanitized = sanitizeSshTargetGeneration(value)
    if (sanitized !== undefined && sanitized > result) {
      result = sanitized
    }
  }
  return result
}

/** Highest generation considered already issued; the next allocation is this + 1. */
export function resolveSshTargetGenerationHighWaterMark(
  input: SshTargetGenerationHighWaterInput
): number {
  const seed = sanitizeSshTargetGeneration(input.persistedCounter) ?? 0
  return highest(input.capturedGenerations, highest(input.targetGenerations, seed))
}

export function nextSshTargetGeneration(highWaterMark: number): number {
  const sanitized = sanitizeSshTargetGeneration(highWaterMark) ?? 0
  return sanitized + 1
}
