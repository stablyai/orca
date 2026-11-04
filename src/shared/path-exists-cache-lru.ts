export const TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES = 1024

export function readTerminalPathExistsCache<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key)
  if (value !== undefined) {
    cache.delete(key)
    cache.set(key, value)
  }
  return value
}

export function writeTerminalPathExistsCache<T>(
  cache: Map<string, T>,
  key: string,
  value: T
): void {
  if (cache.has(key)) {
    cache.delete(key)
  } else {
    // Bound recent probes because terminal output can name unlimited unique paths.
    while (cache.size >= TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      cache.delete(oldestKey)
    }
  }
  cache.set(key, value)
}
