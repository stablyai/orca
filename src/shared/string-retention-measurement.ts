/** Shared measurement rig for the detached-string retention guards. */

const MIB = 1024 * 1024
/** A detached tail must cost far less than the sources it would pin undetached. */
const DEFAULT_PINNED_FRACTION = 4

/** Collect twice so freshly unreachable parents are released. */
export function forceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc
  if (typeof gc !== 'function') {
    throw new Error(
      'Retention guards need --expose-gc. Run with `--config config/vitest.config.ts`, ' +
        'which sets it in test.execArgv; a bare `vitest run` finds no config and omits it.'
    )
  }
  gc()
  gc()
}

export type RetentionCase = {
  name: string
  sourceChars: number
  samples: number
  maxRetainedMiB?: number
  source: (index: number) => string
  /** Runs before the measured window, for cases whose source must reach disk first. */
  prepare?: (source: string, index: number) => void
  retain: (source: string, index: number) => unknown
  verify: (first: never) => void
}

/** Preserves per-case `retain`/`verify` typing that the erased `RetentionCase` cannot. */
export function retentionCase<T>(entry: {
  name: string
  sourceChars: number
  samples: number
  maxRetainedMiB?: number
  source: (index: number) => string
  prepare?: (source: string, index: number) => void
  retain: (source: string, index: number) => T
  verify: (first: T) => void
}): RetentionCase {
  return entry as RetentionCase
}

export type RetentionMeasurement = {
  retainedMiB: number
  pinnedMiB: number
  budgetMiB: number
  samples: number
  first: unknown
}

export function measureRetention(entry: RetentionCase): RetentionMeasurement {
  const pinnedMiB = (entry.sourceChars * entry.samples) / MIB

  if (entry.prepare) {
    for (let index = 0; index < entry.samples; index += 1) {
      entry.prepare(entry.source(index), index)
    }
  }

  forceGc()
  const before = process.memoryUsage().heapUsed
  const retained: unknown[] = []
  for (let index = 0; index < entry.samples; index += 1) {
    retained.push(entry.retain(entry.source(index), index))
  }
  forceGc()
  const retainedMiB = (process.memoryUsage().heapUsed - before) / MIB

  return {
    retainedMiB,
    pinnedMiB,
    budgetMiB: entry.maxRetainedMiB ?? pinnedMiB / DEFAULT_PINNED_FRACTION,
    samples: retained.length,
    first: retained[0]
  }
}
