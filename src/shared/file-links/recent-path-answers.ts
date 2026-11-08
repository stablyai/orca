export const RECENT_PATH_ANSWERS_MAX = 1024

export function readRecentPathAnswer<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key)
  if (value !== undefined) {
    cache.delete(key)
    cache.set(key, value)
  }
  return value
}

export function writeRecentPathAnswer<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.has(key)) {
    cache.delete(key)
  } else {
    // Bound recent answers: terminal output and chat text can name unlimited unique paths.
    while (cache.size >= RECENT_PATH_ANSWERS_MAX) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      cache.delete(oldestKey)
    }
  }
  cache.set(key, value)
}
