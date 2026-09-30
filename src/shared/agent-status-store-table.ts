// One keyed table of the status store, as a mutation sees it.
//
// A mutation writes into a draft over the committed map instead of a copy of it: the draft holds
// only the keys the mutation touched, so a refused mutation is dropped without undoing anything,
// and an accepted one lands in place. Map order is part of the store's observable state (snapshot
// order, tombstone compaction), so the draft reproduces exactly the order a copied map would have.

export type AgentStatusStoreTable<V> = {
  readonly size: number
  get(key: string): V | undefined
  has(key: string): boolean
  set(key: string, value: V): void
  delete(key: string): void
  /** In map order, tolerating deletes of the entry being visited. */
  entries(): Iterable<[string, V]>
}

const REMOVED: unique symbol = Symbol('removed')
type Change<V> = V | typeof REMOVED

export class AgentStatusStoreDraftTable<V> implements AgentStatusStoreTable<V> {
  /** Every key this mutation touched, with its latest value. */
  private readonly changes = new Map<string, Change<V>>()
  /** Committed keys this mutation deleted (a later set re-appends them). */
  private readonly removedFromBase = new Set<string>()
  /** Keys present now that the committed map does not hold in place, in append order. */
  private readonly appended = new Set<string>()

  constructor(private readonly base: ReadonlyMap<string, V>) {}

  get size(): number {
    return this.base.size - this.removedFromBase.size + this.appended.size
  }

  get(key: string): V | undefined {
    const change = this.changes.get(key)
    if (change === undefined) {
      return this.base.get(key)
    }
    return change === REMOVED ? undefined : change
  }

  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  set(key: string, value: V): void {
    if (!this.has(key)) {
      // A Map appends a key it does not hold, including one deleted earlier.
      this.appended.delete(key)
      this.appended.add(key)
    }
    this.changes.set(key, value)
  }

  delete(key: string): void {
    if (!this.has(key)) {
      return
    }
    this.changes.set(key, REMOVED)
    if (this.base.has(key)) {
      this.removedFromBase.add(key)
    }
    this.appended.delete(key)
  }

  *entries(): Iterable<[string, V]> {
    for (const [key, value] of this.base) {
      if (this.removedFromBase.has(key)) {
        continue
      }
      const change = this.changes.get(key)
      yield [key, change === undefined || change === REMOVED ? value : change]
    }
    for (const key of this.appended) {
      const value = this.get(key)
      if (value !== undefined) {
        yield [key, value]
      }
    }
  }

  /** Each touched key with its committed value and its value after this mutation. */
  *touched(): Iterable<{ key: string; previous: V | undefined; next: V | undefined }> {
    for (const [key, change] of this.changes) {
      yield { key, previous: this.base.get(key), next: change === REMOVED ? undefined : change }
    }
  }

  /** Committed keys this mutation deleted, then keys it appended, in the order they now sit. */
  get removedKeys(): ReadonlySet<string> {
    return this.removedFromBase
  }

  get appendedKeys(): ReadonlySet<string> {
    return this.appended
  }

  /** Land the draft in the committed map, leaving it in the order a copied map would have. */
  commitInto(base: Map<string, V>): void {
    for (const key of this.removedFromBase) {
      base.delete(key)
    }
    for (const [key, change] of this.changes) {
      if (change !== REMOVED && !this.appended.has(key)) {
        base.set(key, change)
      }
    }
    for (const key of this.appended) {
      const value = this.get(key)
      if (value !== undefined) {
        base.set(key, value)
      }
    }
  }
}
