/**
 * Which lineage slots must be re-projected before they are read. A counting segment tree: each
 * node holds how many stale slots its subtree covers, so a read finds the k stale slots in its
 * range in O(k log N) by skipping fresh subtrees, never by scanning the range.
 */
export type StaleSlotSet = {
  /** Every slot stale (a structural change): O(N) integer writes, no projections. */
  markAll: () => void
  mark: (index: number) => void
  clear: (index: number) => void
  /** Stale slots in [start, end), ascending. Returns how many tree nodes it visited. */
  forEachStale: (start: number, end: number, visit: (index: number) => void) => number
}

export function createStaleSlotSet(length: number): StaleSlotSet {
  const size = 2 ** Math.ceil(Math.log2(Math.max(length, 1)))
  const counts = new Int32Array(size * 2)

  function setLeaf(index: number, value: 0 | 1): void {
    let node = size + index
    const delta = value - counts[node]!
    if (delta === 0) {
      return
    }
    while (node >= 1) {
      counts[node]! += delta
      node = Math.floor(node / 2)
    }
  }

  return {
    markAll() {
      counts.fill(0)
      counts.fill(1, size, size + length)
      for (let node = size - 1; node > 0; node--) {
        counts[node] = counts[node * 2]! + counts[node * 2 + 1]!
      }
    },
    mark: (index) => setLeaf(index, 1),
    clear: (index) => setLeaf(index, 0),
    forEachStale(start, end, visit) {
      let visited = 0
      // Explicit stack, left child pushed last so leaves come out in ascending order.
      const stack: number[] = [1, 0, size]
      while (stack.length > 0) {
        const high = stack.pop()!
        const low = stack.pop()!
        const node = stack.pop()!
        visited++
        if (counts[node] === 0 || high <= start || low >= end) {
          continue
        }
        if (node >= size) {
          visit(node - size)
          continue
        }
        const middle = (low + high) / 2
        stack.push(node * 2 + 1, middle, high, node * 2, low, middle)
      }
      return visited
    }
  }
}
