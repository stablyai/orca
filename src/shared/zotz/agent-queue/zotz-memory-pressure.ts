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

const PRESSURE_RANK: Record<ZotzMemoryPressure, number> = { ok: 0, elevated: 1, critical: 2 }

export function strongerZotzMemoryPressure(
  a: ZotzMemoryPressure,
  b: ZotzMemoryPressure
): ZotzMemoryPressure {
  return PRESSURE_RANK[b] > PRESSURE_RANK[a] ? b : a
}

/** Swap written within the window that means the machine is paging out to make room. */
export const ZOTZ_SWAP_GROWTH_ELEVATED_BYTES = 1 * GIB

/**
 * What the OS itself says, beyond free memory: macOS counts swappable pages as free, so a host can
 * look roomy while it pages to disk. Kernel level 2 is warn and 4 is critical (memorystatus).
 */
export function zotzSystemMemoryPressure(input: {
  kernelLevel: number | null
  swapGrowthBytes: number
}): ZotzMemoryPressure {
  if (input.kernelLevel !== null && input.kernelLevel >= 4) {
    return 'critical'
  }
  if (
    (input.kernelLevel !== null && input.kernelLevel >= 2) ||
    input.swapGrowthBytes >= ZOTZ_SWAP_GROWTH_ELEVATED_BYTES
  ) {
    return 'elevated'
  }
  return 'ok'
}
