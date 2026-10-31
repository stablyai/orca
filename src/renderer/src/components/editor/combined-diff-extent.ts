import type { VirtualItem } from '@tanstack/react-virtual'

export type CombinedDiffItemAnchor = {
  key: VirtualItem['key']
  offset: number
  gap: number
}

export class CombinedDiffExtent {
  private items: readonly VirtualItem[] = []
  private source: readonly VirtualItem[] | null = null
  private anchor: CombinedDiffItemAnchor | null = null
  private depth = 0
  private target = 0
  revision = 0
  trailingSlack = 0

  constructor(
    private readonly view: {
      position: () => number
      height: () => number
      project: (items: readonly VirtualItem[], height: number) => void
      write: (position: number) => void
    }
  ) {}

  item(index: number): VirtualItem | undefined {
    return this.items[index]
  }

  capture(index: number, offset: number): CombinedDiffItemAnchor | null {
    const item = this.item(index)
    return item ? { key: item.key, offset, gap: item.start + offset - this.view.position() } : null
  }

  private topAnchor(priority?: VirtualItem['key']): CombinedDiffItemAnchor | null {
    const position = this.view.position()
    const item =
      this.items.find(
        (candidate) =>
          candidate.key === priority &&
          candidate.end > position &&
          candidate.start < position + this.view.height()
      ) ?? this.items.find((candidate) => candidate.end > position)
    return item
      ? {
          key: item.key,
          offset: Math.max(0, position - item.start),
          gap: Math.max(0, item.start - position)
        }
      : null
  }

  publish(items: readonly VirtualItem[], priority?: VirtualItem['key']): void {
    if (items === this.source) {
      this.project(this.view.position())
      return
    }
    this.source = items
    const changed =
      items.length !== this.items.length ||
      items.some((item, index) => {
        const previous = this.items[index]
        return (
          !previous ||
          item.key !== previous.key ||
          item.size !== previous.size ||
          item.start !== previous.start
        )
      })
    if (!changed) {
      this.project(this.view.position())
      return
    }
    const anchor = this.anchor ?? this.topAnchor(priority)
    this.items = items.map((item) => ({ ...item }))
    this.revision += 1
    this.anchor = anchor && items.some((item) => item.key === anchor.key) ? anchor : null
    if (!this.depth) {
      const target = this.position(this.anchor)
      const naturalMax = Math.max(0, (this.items.at(-1)?.end ?? 0) - this.view.height())
      this.apply(target ?? Math.min(this.view.position(), naturalMax))
    }
  }

  private position(anchor: CombinedDiffItemAnchor | null): number | undefined {
    const item = anchor && this.items.find((candidate) => candidate.key === anchor.key)
    return item && anchor ? item.start + Math.min(item.size, anchor.offset) - anchor.gap : undefined
  }

  private project(target: number): void {
    const extent = this.items.at(-1)?.end ?? 0
    this.trailingSlack = Math.max(0, target - Math.max(0, extent - this.view.height()))
    this.view.project(this.items, extent + this.trailingSlack)
  }

  private apply(target: number): boolean {
    this.target = Math.max(0, target)
    this.project(this.target)
    const before = this.view.position()
    if (before !== this.target) {
      this.view.write(this.target)
    }
    return before !== this.view.position()
  }

  restore(anchor: CombinedDiffItemAnchor): boolean {
    const target = this.position(anchor)
    if (target === undefined) {
      return false
    }
    this.anchor = anchor
    return this.apply(target)
  }

  transact(index: number, delta: number, update: () => void): boolean {
    const anchor = this.capture(
      index,
      this.view.position() - (this.item(index)?.start ?? 0) + delta
    )
    if (!anchor) {
      return false
    }
    // The native line delta is a new item offset, not a new screen gap.
    anchor.gap = 0
    this.depth += 1
    try {
      update()
    } finally {
      this.depth -= 1
    }
    return this.restore(anchor)
  }

  navigate(target: number): boolean {
    const extent = this.items.at(-1)?.end ?? 0
    const next = Math.max(0, Math.min(Math.max(0, extent - this.view.height()), target))
    this.anchor = null
    const changed = this.apply(next)
    this.anchor = this.topAnchor()
    return changed
  }

  input(): void {
    this.anchor = null
  }

  scrolled(): void {
    const position = this.view.position()
    if (position !== this.target) {
      this.anchor = null
    }
    this.target = position
    this.project(position)
  }

  invalidate(key: VirtualItem['key']): void {
    if (this.anchor?.key === key) {
      this.anchor = null
    }
  }
}
