/** Addressed deadlines: updating or removing a key never leaves stale heap entries. */
export class KeyedDeadlines {
  private readonly heap = new Map<number, { key: string; at: number }>()
  private readonly positions = new Map<string, number | null>()
  private length = 0

  constructor(private readonly base?: KeyedDeadlines) {
    this.length = base?.size ?? 0
  }

  /** Transaction-private copy-on-write view; the base must stay unchanged until it is discarded. */
  fork(): KeyedDeadlines {
    return new KeyedDeadlines(this)
  }

  private entry(index: number): { key: string; at: number } {
    return this.heap.get(index) ?? this.base!.entry(index)
  }

  private position(key: string): number | undefined {
    return this.positions.has(key)
      ? (this.positions.get(key) ?? undefined)
      : this.base?.position(key)
  }

  set(key: string, at: number | undefined): void {
    this.delete(key)
    if (at === undefined) {
      return
    }
    const index = this.length
    this.heap.set(index, { key, at })
    this.length++
    this.positions.set(key, index)
    this.up(index)
  }

  capture(): KeyedDeadlines {
    const captured = new KeyedDeadlines()
    for (let index = 0; index < this.length; index++) {
      const entry = this.entry(index)
      captured.heap.set(index, entry)
      captured.positions.set(entry.key, index)
    }
    captured.length = this.length
    return captured
  }

  firstKeys(limit: number): string[] {
    const frontier: number[] = [],
      keys: string[] = []
    const push = (index: number): void => {
      let position = frontier.length
      frontier.push(index)
      while (position > 0) {
        const parent = (position - 1) >> 1
        if (this.entry(frontier[parent]).at <= this.entry(index).at) {
          break
        }
        frontier[position] = frontier[parent]
        position = parent
      }
      frontier[position] = index
    }
    if (this.length) {
      push(0)
    }
    while (frontier.length && keys.length < limit) {
      const index = frontier[0],
        last = frontier.pop()!
      if (frontier.length) {
        let position = 0
        while (position * 2 + 1 < frontier.length) {
          const left = position * 2 + 1,
            right = left + 1
          const child =
            right < frontier.length &&
            this.entry(frontier[right]).at < this.entry(frontier[left]).at
              ? right
              : left
          if (this.entry(last).at <= this.entry(frontier[child]).at) {
            break
          }
          frontier[position] = frontier[child]
          position = child
        }
        frontier[position] = last
      }
      keys.push(this.entry(index).key)
      for (const child of [index * 2 + 1, index * 2 + 2]) {
        if (child < this.length) {
          push(child)
        }
      }
    }
    return keys
  }

  get firstKey(): string | undefined {
    return this.length ? this.entry(0).key : undefined
  }

  get next(): number {
    return this.length ? this.entry(0).at : Infinity
  }
  get size(): number {
    return this.length
  }

  takeDue(now: number): string[] {
    const due: string[] = []
    while (this.length && this.entry(0).at < now) {
      const key = this.entry(0).key
      this.delete(key)
      due.push(key)
    }
    return due
  }

  clear(): void {
    if (this.base) {
      for (let index = 0; index < this.length; index++) {
        this.positions.set(this.entry(index).key, null)
      }
    } else {
      this.positions.clear()
    }
    this.length = 0
    this.heap.clear()
  }

  delete(key: string): void {
    const index = this.position(key)
    if (index === undefined) {
      return
    }
    if (this.base) {
      this.positions.set(key, null)
    } else {
      this.positions.delete(key)
    }
    const last = this.entry(--this.length)
    this.heap.delete(this.length)
    if (index === this.length) {
      return
    }
    this.heap.set(index, last)
    this.positions.set(last.key, index)
    this.down(this.up(index))
  }

  private up(start: number): number {
    let index = start
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.entry(parent).at <= this.entry(index).at) {
        break
      }
      this.swap(index, parent)
      index = parent
    }
    return index
  }

  private down(start: number): void {
    let index = start
    while (true) {
      const left = index * 2 + 1
      if (left >= this.length) {
        return
      }
      const right = left + 1
      const next = right < this.length && this.entry(right).at < this.entry(left).at ? right : left
      if (this.entry(index).at <= this.entry(next).at) {
        return
      }
      this.swap(index, next)
      index = next
    }
  }

  private swap(a: number, b: number): void {
    const first = this.entry(a)
    this.heap.set(a, this.entry(b))
    this.heap.set(b, first)
    this.positions.set(this.entry(a).key, a)
    this.positions.set(this.entry(b).key, b)
  }
}
