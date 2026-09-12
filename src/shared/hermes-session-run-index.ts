/** Exact keys win; otherwise select the nearest unused earlier session, with source-order ties. */
export class HermesSessionRunIndex {
  readonly used = new Set<number>()
  private readonly exact = new Map<string | null, { indices: number[]; cursor: number }>()
  private readonly timed: { time: number; index: number }[] = []
  private readonly positionByIndex = new Map<number, number>()
  private readonly predecessors: number[]

  constructor(
    keys: (string | null)[],
    private readonly parseTime: (key: string | null) => number,
    private readonly maxGapMs: number
  ) {
    keys.forEach((key, index) => {
      let group = this.exact.get(key)
      if (!group) {
        group = { indices: [], cursor: 0 }
        this.exact.set(key, group)
      }
      group.indices.push(index)
      const time = parseTime(key)
      if (Number.isFinite(time)) {
        this.timed.push({ time, index })
      }
    })
    // The rightmost equal-time row must be the first row in source order.
    this.timed.sort((a, b) => a.time - b.time || b.index - a.index)
    this.timed.forEach((row, position) => this.positionByIndex.set(row.index, position + 1))
    // Zero is the sentinel before the first row; consumed rows link to their predecessor.
    this.predecessors = Array.from({ length: this.timed.length + 1 }, (_, position) => position)
  }

  find(key: string | null): number | null {
    const group = this.exact.get(key)
    if (group) {
      while (group.cursor < group.indices.length && this.used.has(group.indices[group.cursor])) {
        group.cursor++
      }
      if (group.cursor < group.indices.length) {
        return group.indices[group.cursor]
      }
    }
    const time = this.parseTime(key)
    if (!Number.isFinite(time)) {
      return null
    }
    let low = 0
    let high = this.timed.length
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2)
      if (this.timed[mid].time <= time) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    const position = this.findPredecessor(low)
    if (position === 0) {
      return null
    }
    const candidate = this.timed[position - 1]
    return time - candidate.time <= this.maxGapMs ? candidate.index : null
  }

  use(index: number): void {
    this.used.add(index)
    const position = this.positionByIndex.get(index)
    if (position !== undefined) {
      this.predecessors[position] = this.findPredecessor(position - 1)
    }
  }

  private findPredecessor(position: number): number {
    let root = position
    while (this.predecessors[root] !== root) {
      root = this.predecessors[root]
    }
    while (this.predecessors[position] !== position) {
      const next = this.predecessors[position]
      this.predecessors[position] = root
      position = next
    }
    return root
  }
}
