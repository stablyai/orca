const NO_KEYS: ReadonlySet<never> = new Set()

/** A Map that indexes the refs each value holds inside its own writes, so a ref resolves to its keys without a scan. */
export class ReverseIndexedMap<K, V, R> extends Map<K, V> {
  private readonly refsByKey = new Map<K, ReadonlySet<R>>()
  private readonly keysByRef = new Map<R, Set<K>>()

  /** `sameRefs` lets an overwrite skip reindexing when the new value cannot hold other refs. */
  constructor(
    private readonly refsOf: (value: V) => Iterable<R>,
    private readonly sameRefs?: (previous: V, next: V) => boolean
  ) {
    super()
  }

  keysFor(ref: R): ReadonlySet<K> {
    return this.keysByRef.get(ref) ?? NO_KEYS
  }

  override set(key: K, value: V): this {
    const previous = super.get(key)
    if (previous === undefined || !this.sameRefs?.(previous, value)) {
      this.reindex(key, new Set(this.refsOf(value)))
    }
    return super.set(key, value)
  }

  override delete(key: K): boolean {
    this.reindex(key, null)
    return super.delete(key)
  }

  override clear(): void {
    this.refsByKey.clear()
    this.keysByRef.clear()
    super.clear()
  }

  private reindex(key: K, next: ReadonlySet<R> | null): void {
    const previous = this.refsByKey.get(key)
    for (const ref of previous ?? []) {
      if (next?.has(ref)) {
        continue
      }
      const keys = this.keysByRef.get(ref)
      keys?.delete(key)
      if (keys?.size === 0) {
        this.keysByRef.delete(ref)
      }
    }
    for (const ref of next ?? []) {
      if (previous?.has(ref)) {
        continue
      }
      let keys = this.keysByRef.get(ref)
      if (!keys) {
        keys = new Set()
        this.keysByRef.set(ref, keys)
      }
      keys.add(key)
    }
    if (next && next.size > 0) {
      this.refsByKey.set(key, next)
    } else {
      this.refsByKey.delete(key)
    }
  }
}
