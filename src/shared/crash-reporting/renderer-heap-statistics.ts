/** Exact, uncached V8 counters from a sandboxed preload, in Electron-reported KB.
 * Blink’s performance.memory buckets/cache hide heap growth for roughly 20 minutes. */
export type RendererHeapStatistics = {
  usedHeapKB: number
  totalHeapKB: number
  heapLimitKB: number
  /** Off-heap V8 allocations, which `usedJSHeapSize` never included. */
  mallocedKB: number
  /** Blink DOM/layout allocations are supplementary; missing values must not discard V8 counters. */
  blinkAllocatedKB?: number
}
