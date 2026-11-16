/** Registration generations advance on create/re-create/re-adopt, never reconnect (connectionGeneration).
 * Restore the high-water mark across counter, targets and captured automation generations so rollback cannot reuse a fenced incarnation. */

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
  persistedCounter?: number | null
  targetGenerations: Iterable<number | null | undefined>
  /** Captured automation fences survive counter rollback. */
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
