import { GIB } from './zotz-memory-governor-defaults'

export type ZotzMemoryPressure = 'ok' | 'elevated' | 'critical'

const ELEVATED_AVAILABLE_FRACTION = 0.2
const ELEVATED_MARGIN_BYTES = 1 * GIB

/**
 * docs/zotz/PLAN.md §8d: critical below the reserved minimum; elevated below 20 % of RAM or
 * within 1 GB of the minimum, where nothing new is admitted.
 */
export function zotzMemoryPressure(input: {
  availableBytes: number
  totalBytes: number
  minFreeBytes: number
}): ZotzMemoryPressure {
  if (input.availableBytes < input.minFreeBytes) {
    return 'critical'
  }
  const elevatedBelow = Math.max(
    input.totalBytes * ELEVATED_AVAILABLE_FRACTION,
    input.minFreeBytes + ELEVATED_MARGIN_BYTES
  )
  return input.availableBytes < elevatedBelow ? 'elevated' : 'ok'
}
