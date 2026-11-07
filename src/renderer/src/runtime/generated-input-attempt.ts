import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeCompatibilityCacheEntry } from './runtime-compatibility-cache'

/** The status one generated request's paired-host route was chosen by, with the pairing that
 *  request is fixed to (null: unknown, so main fixes it at its first resolution). */
export type GeneratedInputSelection = {
  environmentId: string
  status: RuntimeStatus
  entry: RuntimeCompatibilityCacheEntry
  pairingRevision: number | null
}

/** One accepted generated request from its producer to its frames' handoff: its own end on this
 *  machine, fixed once, and the route it selected once. Every send of it, an older host's
 *  frames included, spends this end and goes by this selection; neither is ever chosen again. */
export type GeneratedInputAttempt = {
  /** Absolute; null when the caller set no deadline. */
  readonly end: number | null
  selection?: GeneratedInputSelection
}

export function generatedInputAttempt(end: number | null): GeneratedInputAttempt {
  return { end }
}

/** Time left before the attempt's end; undefined when it has none. */
export function generatedInputRemainingMs(attempt: GeneratedInputAttempt): number | undefined {
  return attempt.end === null ? undefined : Math.floor(attempt.end - Date.now())
}

/** Whether the attempt's end has passed, so none of it may be sent any more. */
export function generatedInputAttemptExpired(attempt: GeneratedInputAttempt): boolean {
  const remaining = generatedInputRemainingMs(attempt)
  return remaining !== undefined && remaining < 1
}
