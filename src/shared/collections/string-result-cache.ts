export function memoizeStringResult<T>(
  compute: (key: string) => T,
  maxEntries: number
): (key: string) => T {
  // Box results so undefined and null are cache hits too.
  const cache = new Map<string, { value: T }>()
  return (key: string): T => {
    const cached = cache.get(key)
    if (cached) {
      return cached.value
    }
    const value = compute(key)
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next()
      if (!oldest.done) {
        cache.delete(oldest.value)
      }
    }
    cache.set(key, { value })
    return value
  }
}
