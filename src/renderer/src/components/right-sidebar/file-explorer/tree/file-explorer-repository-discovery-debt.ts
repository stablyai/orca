/** Ready work and one keyed retry deadline per unresolved input; settled negatives own neither. */
export class ExplorerRepositoryDiscoveryDebt {
  private ready = new Set<string>()
  private retries: { path: string; at: number }[] = []
  private positions = new Map<string, number>()

  dueAt(): number {
    return this.ready.size ? -Infinity : (this.retries[0]?.at ?? Infinity)
  }

  capture(): string[] {
    while (this.retries.length && this.retries[0].at <= Date.now()) {
      this.invalidate(this.retries[0].path)
    }
    return [...this.ready]
  }

  isReady(path: string): boolean {
    return this.ready.has(path)
  }

  invalidate(path: string): void {
    this.delete(path)
    this.ready.add(path)
  }

  retry(path: string): void {
    this.delete(path)
    const index = this.retries.length
    this.retries.push({ path, at: Date.now() + 60_000 })
    this.positions.set(path, index)
    this.repair(index)
  }

  delete(path: string): void {
    this.ready.delete(path)
    const index = this.positions.get(path)
    if (index === undefined) {
      return
    }
    this.positions.delete(path)
    const last = this.retries.pop()!
    if (index < this.retries.length) {
      this.retries[index] = last
      this.positions.set(last.path, index)
      this.repair(index)
    }
  }

  clear(): void {
    this.ready.clear()
    this.retries = []
    this.positions.clear()
  }

  private swap(a: number, b: number): void {
    const item = this.retries[a]
    this.retries[a] = this.retries[b]
    this.retries[b] = item
    this.positions.set(this.retries[a].path, a)
    this.positions.set(this.retries[b].path, b)
  }

  private repair(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >>> 1
      if (this.retries[parent].at <= this.retries[index].at) {
        break
      }
      this.swap(index, parent)
      index = parent
    }
    for (;;) {
      const left = index * 2 + 1
      if (left >= this.retries.length) {
        return
      }
      const right = left + 1
      const child =
        right < this.retries.length && this.retries[right].at < this.retries[left].at ? right : left
      if (this.retries[index].at <= this.retries[child].at) {
        return
      }
      this.swap(index, child)
      index = child
    }
  }
}
