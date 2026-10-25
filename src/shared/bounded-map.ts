// Insertion-ordered LRU with count/byte limits. get changes order, so iteration snapshots tolerate reads.
// set true means retained; reject oversized/unmeasurable values without displacing prior entries. Sample safe-integer weights at set; reset mutated values to update accounting.
// onEvict handles capacity eviction only, never delete/clear/overwrite; restore both bounds before callbacks.

export type BoundedMapOptions<K, V> = {
  maxEntries: number
  // Aggregate retained-byte ceiling across all values; omit for count-only bounding.
  maxBytes?: number
  // Per-entry ceiling, clamped to maxBytes. Defaults to maxBytes.
  maxEntryBytes?: number
  // Retained bytes for a value; required when maxBytes or maxEntryBytes is set.
  sizeOf?: (value: V, key: K) => number
  // Dispose hook for capacity eviction only.
  onEvict?: (value: V, key: K) => void
}

// Safe integer byte weights avoid float residue/Infinity corrupting admission.
function assertCeiling(name: string, value: number | undefined): void {
  if (value === undefined) {
    return
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`BoundedMap ${name} must be a non-negative safe integer`)
  }
}

// Match Map's SameValueZero: === would fail to protect an admitted NaN key from eviction.
function isSameKey<K>(a: K, b: K): boolean {
  return a === b || (Number.isNaN(a as unknown as number) && Number.isNaN(b as unknown as number))
}

export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>()
  private readonly bytesByKey = new Map<K, number>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly maxEntryBytes: number
  private readonly sizeOf: (value: V, key: K) => number
  private readonly onEvict?: (value: V, key: K) => void
  private retained = 0

  constructor(options: BoundedMapOptions<K, V>) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError('BoundedMap maxEntries must be a positive safe integer')
    }
    // Validate ceilings before sizeOf so invalid bounds consistently raise RangeError.
    assertCeiling('maxBytes', options.maxBytes)
    assertCeiling('maxEntryBytes', options.maxEntryBytes)
    if (
      (options.maxBytes !== undefined || options.maxEntryBytes !== undefined) &&
      !options.sizeOf
    ) {
      throw new Error('BoundedMap requires sizeOf when maxBytes or maxEntryBytes is set')
    }
    this.maxEntries = options.maxEntries
    this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
    // Clamp per-entry to total or admission would immediately evict the key while reporting success.
    this.maxEntryBytes = Math.min(options.maxEntryBytes ?? this.maxBytes, this.maxBytes)
    this.sizeOf = options.sizeOf ?? (() => 0)
    this.onEvict = options.onEvict
  }

  get size(): number {
    return this.map.size
  }

  get retainedBytes(): number {
    return this.retained
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  // Marks the key most-recently-used.
  get(key: K): V | undefined {
    if (!this.map.has(key)) {
      return undefined
    }
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  // Reads without affecting eviction order.
  peek(key: K): V | undefined {
    return this.map.get(key)
  }

  // Returns false when the entry is rejected; a rejected entry never displaces an existing value.
  set(key: K, value: V): boolean {
    // Reject measurement failure without touching the ledger: NaN would disable future ceilings, and throws may escape into remote relay callers.
    let measured: number
    try {
      measured = this.sizeOf(value, key)
    } catch {
      return false
    }
    if (!Number.isSafeInteger(measured) || measured < 0 || measured > this.maxEntryBytes) {
      return false
    }
    // Credit displaced weight arithmetically before mutation so rejection preserves the prior entry and exact ledger.
    const replacing = this.map.has(key) ? (this.bytesByKey.get(key) ?? 0) : 0
    if (measured > Number.MAX_SAFE_INTEGER - (this.retained - replacing)) {
      return false
    }
    if (this.map.has(key)) {
      this.retained -= replacing
      this.map.delete(key)
    }
    this.map.set(key, value)
    this.bytesByKey.set(key, measured)
    this.retained += measured
    this.evictToFit(key)
    // Reentrant onEvict may remove the new key; report presence so true always means retained.
    return this.map.has(key)
  }

  delete(key: K): boolean {
    if (!this.map.has(key)) {
      return false
    }
    this.retained -= this.bytesByKey.get(key) ?? 0
    this.bytesByKey.delete(key)
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
    this.bytesByKey.clear()
    this.retained = 0
  }

  // Snapshots: safe to iterate while calling get(), which reorders the backing map.
  keys(): K[] {
    return [...this.map.keys()]
  }

  values(): V[] {
    return [...this.map.values()]
  }

  entries(): [K, V][] {
    return [...this.map.entries()]
  }

  private evictToFit(protectedKey: K): void {
    const disposed: [K, V][] = []
    while (this.map.size > this.maxEntries || this.retained > this.maxBytes) {
      const oldest = this.map.entries().next()
      if (oldest.done) {
        break
      }
      const [key, value] = oldest.value
      // Clamping per-entry bytes prevents evicting the key this set just admitted.
      if (isSameKey(key, protectedKey)) {
        break
      }
      this.retained -= this.bytesByKey.get(key) ?? 0
      this.bytesByKey.delete(key)
      this.map.delete(key)
      disposed.push([key, value])
    }
    if (!this.onEvict) {
      return
    }
    // Restore bounds before callbacks and isolate disposal failures so throws/reentry cannot strand capacity or skip remaining cleanup.
    let firstFailure: unknown
    let failed = false
    for (const [key, value] of disposed) {
      try {
        this.onEvict(value, key)
      } catch (error) {
        if (!failed) {
          failed = true
          firstFailure = error
        }
      }
    }
    if (failed) {
      throw firstFailure
    }
  }
}
