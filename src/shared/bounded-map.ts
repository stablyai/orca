// Count- and byte-bounded insertion-ordered LRU map: one tested implementation of the
// "Map + entry counter + retained-byte ledger + evict-oldest" pattern.
//
// Contract:
// - get() marks a key most-recently-used. Reads therefore MUTATE order, so keys()/values()/entries()
//   return snapshots — iterating while touching keys is safe and terminates.
// - set() admits or rejects; it never reports success for an entry it did not retain. An entry over
//   maxEntryBytes is rejected and any previously stored value for that key is left untouched.
// - Weights must be non-negative safe integers (bytes). An unmeasurable weight fails CLOSED (entry
//   rejected, ledger untouched) rather than poisoning the ledger and silently disabling the ceiling.
// - A value's measured weight is sampled once at set(); callers holding MUTABLE values must re-set
//   after mutation, or the ledger will under-count what is actually retained.
// - onEvict fires only for involuntary capacity eviction — never for delete(), clear(), or the value
//   an overwrite replaces — and only after both bounds have been restored.

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

// Why safe integers: bytes are whole units, and float ledgers accumulate residue that can drift
// negative or saturate to Infinity, permanently corrupting later admission decisions.
function assertCeiling(name: string, value: number | undefined): void {
  if (value === undefined) {
    return
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`BoundedMap ${name} must be a non-negative safe integer`)
  }
}

// Why SameValueZero: Map key equality treats NaN as equal to NaN, but === does not; a === guard
// would fail to protect a just-admitted NaN key and evict it after reporting success.
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
    // Why validate ceilings first: an invalid ceiling is a RangeError regardless of whether the
    // caller also forgot sizeOf, so the more specific error should not mask it.
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
    // Why: a per-entry ceiling above the aggregate would admit an entry that eviction must then
    // immediately discard, making set() return true for a key the map no longer holds.
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
    // Why: an unmeasurable weight must not enter the ledger — a NaN would make every later
    // comparison false and silently retire the ceiling, so measurement failure rejects the entry
    // rather than throwing into a caller that may be a relay on someone else's machine.
    let measured: number
    try {
      measured = this.sizeOf(value, key)
    } catch {
      return false
    }
    if (!Number.isSafeInteger(measured) || measured < 0 || measured > this.maxEntryBytes) {
      return false
    }
    // Why compute headroom before mutating: the ledger must stay exact, but a rejection here must
    // not have already dropped the value it is replacing, so the displaced weight is credited
    // arithmetically rather than by deleting first.
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
    // Why report presence rather than true: a reentrant onEvict can evict this key from a nested
    // set(), and the contract is that a true return means the entry is retained.
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
      // Why: clamping maxEntryBytes keeps the just-admitted entry within the aggregate, so reaching
      // it here would mean evicting the key set() just reported as retained.
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
    // Why: bounds are restored before any disposal runs, so a hook that throws or reenters cannot
    // strand the map over capacity; each disposal is isolated so one failure still frees the rest.
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
