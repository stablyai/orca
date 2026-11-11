import type { BrowserGuestActivity } from './browser-guest-activity'

type RankedGuest = { pageId: string; entry: BrowserGuestActivity; key: number }

/** One node per eligible guest; canonical ranks survive protection changes without stale nodes. */
export class BrowserGuestPriorityIndex {
  private items: RankedGuest[] = []
  private positions = new Map<string, number>()

  peek(): RankedGuest | undefined {
    return this.items[0]
  }

  set(pageId: string, entry: BrowserGuestActivity, key: number): void {
    const index = this.positions.get(pageId) ?? this.items.length
    this.items[index] = { pageId, entry, key }
    this.positions.set(pageId, index)
    this.siftDown(this.siftUp(index))
  }

  delete(pageId: string): void {
    const index = this.positions.get(pageId)
    if (index === undefined) {
      return
    }
    this.positions.delete(pageId)
    const last = this.items.pop()
    if (last && index < this.items.length) {
      this.items[index] = last
      this.positions.set(last.pageId, index)
      this.siftDown(this.siftUp(index))
    }
  }

  pop(): RankedGuest | undefined {
    const first = this.peek()
    if (first) {
      this.delete(first.pageId)
    }
    return first
  }

  clear(): void {
    this.items = []
    this.positions.clear()
  }

  private swap(left: number, right: number): void {
    const first = this.items[left]
    const second = this.items[right]
    this.items[left] = second
    this.items[right] = first
    this.positions.set(first.pageId, right)
    this.positions.set(second.pageId, left)
  }

  private siftUp(index: number): number {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.items[parent].key <= this.items[index].key) {
        break
      }
      this.swap(parent, index)
      index = parent
    }
    return index
  }

  private siftDown(index: number): void {
    while (index * 2 + 1 < this.items.length) {
      const left = index * 2 + 1
      const right = left + 1
      const child =
        right < this.items.length && this.items[right].key < this.items[left].key ? right : left
      if (this.items[index].key <= this.items[child].key) {
        break
      }
      this.swap(index, child)
      index = child
    }
  }
}
