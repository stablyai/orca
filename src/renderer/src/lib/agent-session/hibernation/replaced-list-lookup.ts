// Positions of closed tabs and gone processes are dropped wholesale past this, then relearned.
const RETAINED_POSITION_LIMIT = 4096

/**
 * Finds an item by key in store lists that are replaced on every edit. Positions learned from an
 * earlier list are tried first and verified, so a sibling's edit costs one read; a list is indexed
 * only when its items moved, once per list.
 */
export class ReplacedListLookup<T> {
  // Replaced whenever positions are dropped: an indexed list's missing key must mean absent.
  private indexedLists = new WeakSet<readonly T[]>()
  private readonly positionByKey = new Map<string, number>()

  constructor(private readonly keyOf: (item: T) => string) {}

  find(list: readonly T[], key: string): T | undefined {
    const known = this.at(list, key)
    if (known !== undefined || this.indexedLists.has(list)) {
      return known
    }
    if (this.positionByKey.size + list.length > RETAINED_POSITION_LIMIT) {
      this.clear()
    }
    list.forEach((item, position) => this.positionByKey.set(this.keyOf(item), position))
    this.indexedLists.add(list)
    return this.at(list, key)
  }

  clear(): void {
    this.positionByKey.clear()
    this.indexedLists = new WeakSet()
  }

  private at(list: readonly T[], key: string): T | undefined {
    const position = this.positionByKey.get(key)
    return position !== undefined && position < list.length && this.keyOf(list[position]) === key
      ? list[position]
      : undefined
  }
}
