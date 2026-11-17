/**
 * A read-only Map: an immutable base with a few replaced values. Each instance is a new identity
 * for memo deps without copying the base. Overlay keys must already be base keys.
 */
export class ReadOnlyOverlayMap<K, V> extends Map<K, V> {
  readonly #base: ReadonlyMap<K, V>
  readonly #overlay: ReadonlyMap<K, V>
  /** Merged entries, built on the first walk and reused so repeat walks never reread the base. */
  #entries: [K, V][] | null = null

  constructor(base: ReadonlyMap<K, V>, overlay: ReadonlyMap<K, V>) {
    super()
    this.#base = base
    this.#overlay = overlay
  }

  override get size(): number {
    return this.#base.size
  }

  override get(key: K): V | undefined {
    return this.#overlay.get(key) ?? this.#base.get(key)
  }

  override has(key: K): boolean {
    return this.#base.has(key)
  }

  #merged(): [K, V][] {
    this.#entries ??= Array.from(this.#base, ([key, value]): [K, V] => [
      key,
      this.#overlay.get(key) ?? value
    ])
    return this.#entries
  }

  override *entries(): MapIterator<[K, V]> {
    yield* this.#merged()
  }

  override *keys(): MapIterator<K> {
    for (const [key] of this.#merged()) {
      yield key
    }
  }

  override *values(): MapIterator<V> {
    for (const [, value] of this.#merged()) {
      yield value
    }
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries()
  }

  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#merged()) {
      callback.call(thisArg, value, key, this)
    }
  }

  override set(): this {
    throw new Error('ReadOnlyOverlayMap is read-only')
  }

  override delete(): boolean {
    throw new Error('ReadOnlyOverlayMap is read-only')
  }

  override clear(): void {
    throw new Error('ReadOnlyOverlayMap is read-only')
  }
}
