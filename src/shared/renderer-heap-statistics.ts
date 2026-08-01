/**
 * V8 heap statistics read from the renderer's own process.
 *
 * Why this exists rather than `window.performance.memory`: Blink quantizes that
 * API onto ~100 logarithmic buckets and caches each reading for ~20 minutes as a
 * Spectre mitigation. Measured here: a renderer climbing 1MB -> 93MB reported an
 * identical `usedJSHeapSize` on all 7 samples, so heap growth is invisible to it
 * at any sampling rate. `process.getHeapStatistics()` is exact and uncached, and
 * works in a sandboxed, context-isolated preload.
 *
 * Electron reports these in kilobytes; we keep that unit unconverted here.
 *
 * No per-space breakdown: `v8.getHeapSpaceStatistics()` needs the `v8` module,
 * which a sandboxed preload cannot require. These are every field Electron's own
 * `process.getHeapStatistics()` exposes.
 */
export type RendererHeapStatistics = {
  usedHeapKB: number
  totalHeapKB: number
  heapLimitKB: number
  /** Committed vs reserved: separates fragmentation from real retention. */
  physicalKB: number
  /** Headroom left before the OOM abort, which `heapLimitKB` alone cannot track. */
  availableKB: number
  /** V8 code space — the one growth shape (compiled code) no JS counter reveals. */
  executableKB: number
  /** Off-heap V8 allocations, which `usedJSHeapSize` never included. */
  mallocedKB: number
  /** High-water mark for `mallocedKB`, which only ever reports the instant value. */
  peakMallocedKB: number
  /**
   * Blink's own allocator (DOM, layout), invisible to the V8 heap counters.
   * Optional: supplementary, so its absence must never discard the V8 numbers.
   */
  blinkAllocatedKB?: number
}
