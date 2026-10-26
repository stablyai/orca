/** Pure title classifiers can reuse verdicts across unrelated store writes; changed titles become new keys, so no invalidation signal is needed. */

/** Bound growth across session length while keeping the live pane/title working set cached. */
const MAX_MEMOIZED_TITLES = 1024

export function memoizeTitleClassification<T>(
  classify: (title: string) => T
): (title: string) => T {
  // Boxed values so `undefined`/`null` verdicts are still cache hits.
  const cache = new Map<string, { value: T }>()
  return (title: string): T => {
    const cached = cache.get(title)
    if (cached) {
      return cached.value
    }
    const value = classify(title)
    // FIFO evicts superseded title frames first; they are least likely to be requested again.
    if (cache.size >= MAX_MEMOIZED_TITLES) {
      const oldest = cache.keys().next()
      if (!oldest.done) {
        cache.delete(oldest.value)
      }
    }
    cache.set(title, { value })
    return value
  }
}
