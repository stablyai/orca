/** Synchronous readers and finite host publication share the same projection. */
export function finishAgentSessionSteps<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done) {
      return next.value
    }
  }
}

/** Stable merge runs preserve insertion order for equal canonical ordinals. */
export function* sortAgentSessionSteps<T>(
  values: Iterable<T>,
  compare: (a: T, b: T) => number
): Generator<void, T[]> {
  let source: T[] = []
  for (const value of values) {
    source.push(value)
    yield
  }
  let target: T[] = []
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += 2 * width) {
      let left = start
      const middle = Math.min(start + width, source.length)
      let right = middle
      const end = Math.min(start + 2 * width, source.length)
      while (left < middle || right < end) {
        target.push(
          right >= end || (left < middle && !(compare(source[left], source[right]) > 0))
            ? source[left++]
            : source[right++]
        )
        yield
      }
    }
    ;[source, target] = [target, source]
    target.length = 0
  }
  return source
}

export function* mapAgentSessionSteps<T, U>(
  values: Iterable<T>,
  map: (value: T, index: number) => U
): Generator<void, U[]> {
  const result: U[] = []
  let index = 0
  for (const value of values) {
    result.push(map(value, index++))
    yield
  }
  return result
}
export function* filterAgentSessionSteps<T>(
  values: Iterable<T>,
  keep: (value: T, index: number) => boolean
): Generator<void, T[]> {
  const result: T[] = []
  let index = 0
  for (const value of values) {
    if (keep(value, index++)) {
      result.push(value)
    }
    yield
  }
  return result
}
export function* flatMapAgentSessionSteps<T, U>(
  values: Iterable<T>,
  map: (value: T, index: number) => readonly U[]
): Generator<void, U[]> {
  const result: U[] = []
  let index = 0
  for (const value of values) {
    for (const entry of map(value, index++)) {
      result.push(entry)
      yield
    }
    yield
  }
  return result
}

export function* indexAgentSessionSteps<K, V>(
  entries: Iterable<readonly [K, V]>
): Generator<void, Map<K, V>> {
  const index = new Map<K, V>()
  for (const [key, value] of entries) {
    index.set(key, value)
    yield
  }
  return index
}
export function* setAgentSessionSteps<T>(entries: Iterable<T>): Generator<void, Set<T>> {
  const set = new Set<T>()
  for (const entry of entries) {
    set.add(entry)
    yield
  }
  return set
}
