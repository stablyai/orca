const GONE: unique symbol = Symbol('gone')
type Change<V> = V | typeof GONE

/** What a reader of a host part needs from a map; values are never undefined. */
export type Lookup<K, V> = { get(key: K): V | undefined; has(key: K): boolean }

function read<K, V>(
  base: ReadonlyMap<K, V>,
  overlay: ReadonlyMap<K, Change<V>>,
  key: K
): V | undefined {
  const change = overlay.get(key)
  if (change !== undefined) {
    return change === GONE ? undefined : change
  }
  return base.get(key)
}

/** An immutable map shared between host parts: a base plus the changes made since, so an edit
 *  copies only those changes. Past about √(size) changes they fold into a new base, which keeps
 *  each edit near O(√size + its own changes) instead of copying the whole map. */
export class OverlayMap<K, V> implements Lookup<K, V> {
  private constructor(
    private readonly base: ReadonlyMap<K, V>,
    private readonly overlay: ReadonlyMap<K, Change<V>>
  ) {}

  static empty<K, V>(): OverlayMap<K, V> {
    return new OverlayMap<K, V>(new Map(), new Map())
  }

  get(key: K): V | undefined {
    return read(this.base, this.overlay, key)
  }

  has(key: K): boolean {
    return this.get(key) !== undefined
  }

  edit(): OverlayMapDraft<K, V> {
    return new OverlayMapDraft(this.base, this.overlay, (base, overlay) => {
      if (overlay.size * overlay.size <= base.size || overlay.size <= 32) {
        return new OverlayMap(base, overlay)
      }
      const folded = new Map(base)
      for (const [key, change] of overlay) {
        if (change === GONE) {
          folded.delete(key)
        } else {
          folded.set(key, change)
        }
      }
      return new OverlayMap<K, V>(folded, new Map())
    })
  }
}

export class OverlayMapDraft<K, V> implements Lookup<K, V> {
  private readonly overlay: Map<K, Change<V>>

  constructor(
    private readonly base: ReadonlyMap<K, V>,
    overlay: ReadonlyMap<K, Change<V>>,
    private readonly seal: (
      base: ReadonlyMap<K, V>,
      overlay: ReadonlyMap<K, Change<V>>
    ) => OverlayMap<K, V>
  ) {
    this.overlay = new Map(overlay)
  }

  get(key: K): V | undefined {
    return read(this.base, this.overlay, key)
  }

  has(key: K): boolean {
    return this.get(key) !== undefined
  }

  set(key: K, value: V): void {
    this.overlay.set(key, value)
  }

  delete(key: K): void {
    if (this.base.has(key)) {
      this.overlay.set(key, GONE)
    } else {
      this.overlay.delete(key)
    }
  }

  finish(): OverlayMap<K, V> {
    return this.seal(this.base, this.overlay)
  }
}
