// Polyfills for modern JavaScript features missing in older environments like Node.js < 22

if (Promise.withResolvers === undefined) {
  Promise.withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

if (Map.groupBy === undefined) {
  Map.groupBy = function <K, T>(
    items: Iterable<T>,
    callbackfn: (value: T, index: number) => K
  ): Map<K, T[]> {
    const map = new Map<K, T[]>()
    let index = 0
    for (const item of items) {
      const key = callbackfn(item, index++)
      const group = map.get(key)
      if (group) {
        group.push(item)
      } else {
        map.set(key, [item])
      }
    }
    return map
  }
}
