import type { ClassifiedError } from './classified-error'

export type EmptyPageOutcome = {
  reason: 'window-unreachable' | 'load-failed' | 'end-of-data'
  /** Count clamp or null; window limits belong in applyWindowPageLimit, never the count slot. */
  clampTotalPagesTo: number | null
}

/** Only all-window 422 errors prove a cap; transient sibling failures win, and clean-empty results may withdraw speculative counts only. */
export function resolveEmptyPageOutcome(args: {
  target: number
  failedCount: number
  errorTypes: readonly ClassifiedError['type'][]
  countedTotalPages: number | null
}): EmptyPageOutcome {
  const clamp = Math.max(1, Math.floor(args.target))
  // A sibling non-window error may hide healthy pages, so it must block the clamp.
  const onlyWindowErrors =
    args.errorTypes.length > 0 && args.errorTypes.every((type) => type === 'validation_error')
  if (onlyWindowErrors && args.failedCount === 0) {
    return { reason: 'window-unreachable', clampTotalPagesTo: clamp }
  }
  if (args.failedCount > 0 || args.errorTypes.length > 0) {
    return { reason: 'load-failed', clampTotalPagesTo: null }
  }
  const countUnknown = args.countedTotalPages === null || args.countedTotalPages === 0
  return { reason: 'end-of-data', clampTotalPagesTo: countUnknown ? clamp : null }
}

/** Clamp speculative counts against the latest committed state; store proven 422 limits separately so late real counts can replace speculation. */
export function applyEmptyPageClamp(
  previous: number | null,
  args: {
    target: number
    failedCount: number
    errorTypes: readonly ClassifiedError['type'][]
  }
): number | null {
  const outcome = resolveEmptyPageOutcome({ ...args, countedTotalPages: previous })
  if (outcome.reason !== 'end-of-data' || outcome.clampTotalPagesTo === null) {
    return previous
  }
  return outcome.clampTotalPagesTo
}

/** Proven window 422 limit: set once, only ever lowered, reset per generation. */
export function applyWindowPageLimit(previous: number | null, target: number): number {
  const clamp = Math.max(1, Math.floor(target))
  return previous === null ? clamp : Math.min(previous, clamp)
}

/** Cap count/fallback by the proven window limit, retaining loaded pages; separate state makes late count updates order-independent. */
export function deriveAdvertisedTotalPages(args: {
  loadedPages: number
  countedTotalPages: number | null
  fallbackTotalPages: number
  provenPageLimit: number | null
}): number {
  const uncapped =
    args.countedTotalPages && args.countedTotalPages > 0
      ? Math.max(args.loadedPages, args.countedTotalPages)
      : args.fallbackTotalPages
  const capped = args.provenPageLimit === null ? uncapped : Math.min(uncapped, args.provenPageLimit)
  return Math.max(args.loadedPages, capped)
}
