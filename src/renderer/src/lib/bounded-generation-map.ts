export type BoundedGenerationMap = {
  get: (key: string) => number
  advance: (key: string) => void
  reset: () => void
}

// Why: evicted keys read the highest evicted generation, so a stale snapshot never matches a fresh one.
export function createBoundedGenerationMap(max: number): BoundedGenerationMap {
  const generations = new Map<string, number>()
  let sequence = 0
  let evicted = 0
  return {
    get: (key) => generations.get(key) ?? evicted,
    advance: (key) => {
      generations.set(key, ++sequence)
      while (generations.size > max) {
        const oldest = generations.keys().next()
        if (oldest.done) {
          break
        }
        evicted = Math.max(evicted, generations.get(oldest.value) ?? 0)
        generations.delete(oldest.value)
      }
    },
    reset: () => {
      generations.clear()
      sequence = 0
      evicted = 0
    }
  }
}
