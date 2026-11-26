export type LineageRangeAggregate<T> = {
  update: (index: number, value: T) => void
  /** Replace a contiguous run of leaves, recombining each shared ancestor once: O(k + log N). */
  updateRun: (start: number, values: readonly T[]) => void
  read: (start: number, end: number) => T
}

/** A preorder lineage range can be refreshed and read without rebuilding its siblings. */
export function createLineageRangeAggregate<T>(
  values: readonly T[],
  empty: () => T,
  combine: (left: T, right: T) => T
): LineageRangeAggregate<T> {
  const size = 2 ** Math.ceil(Math.log2(Math.max(values.length, 1)))
  const segments = Array.from({ length: size * 2 }, empty)
  values.forEach((value, index) => {
    segments[size + index] = value
  })
  for (let node = size - 1; node > 0; node--) {
    segments[node] = combine(segments[node * 2]!, segments[node * 2 + 1]!)
  }
  return {
    update(index, value) {
      let node = size + index
      segments[node] = value
      while (node > 1) {
        node = Math.floor(node / 2)
        segments[node] = combine(segments[node * 2]!, segments[node * 2 + 1]!)
      }
    },
    updateRun(start, values) {
      if (values.length === 0) {
        return
      }
      let low = size + start
      let high = low + values.length - 1
      values.forEach((value, offset) => {
        segments[low + offset] = value
      })
      while (low > 1) {
        low = Math.floor(low / 2)
        high = Math.floor(high / 2)
        for (let node = low; node <= high; node++) {
          segments[node] = combine(segments[node * 2]!, segments[node * 2 + 1]!)
        }
      }
    },
    read(start, end) {
      start += size
      end += size
      let left = empty()
      let right = empty()
      while (start < end) {
        if (start % 2) {
          left = combine(left, segments[start++]!)
        }
        if (end % 2) {
          right = combine(segments[--end]!, right)
        }
        start = Math.floor(start / 2)
        end = Math.floor(end / 2)
      }
      return combine(left, right)
    }
  }
}
