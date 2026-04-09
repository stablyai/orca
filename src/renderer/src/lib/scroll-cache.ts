// Why: 20 entries covers a typical working set of open/recently-viewed files.
// Eviction only means losing a scroll position (user sees top of file), not a
// correctness bug, so a conservative cap is fine.
const CACHE_MAX_ENTRIES = 20

// Why: Module-scoped Maps grow unboundedly as unique file keys accumulate.
// Cap them with a simple LRU eviction: after each set, if the map exceeds
// this limit, delete the oldest entry (Maps iterate in insertion order).
// `maxEntries` is optional so consumers with their own Maps (like
// CombinedDiffViewer) can use different limits.
export function setWithLRU<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number = CACHE_MAX_ENTRIES
): void {
  // Re-insert to refresh insertion order (move to end).
  map.delete(key)
  map.set(key, value)
  if (map.size > maxEntries) {
    // Why: Use the iterator's `.done` property rather than checking
    // `value !== undefined`, because K could legitimately be `undefined`
    // in a generic Map — the undefined check would skip valid evictions.
    const first = map.keys().next()
    if (!first.done) {
      map.delete(first.value)
    }
  }
}

// Why: A single shared Map for scroll positions across all editor components.
// Module-scoped so it survives component unmount/remount without triggering
// React re-renders (unlike Zustand, which would broadcast state changes on
// every scroll event even though no component renders from scroll position).
export const scrollTopCache = new Map<string, number>()

// Why: Same rationale as scrollTopCache — module-scoped avoids Zustand
// re-renders on every cursor move.
export const cursorPositionCache = new Map<string, { lineNumber: number; column: number }>()
