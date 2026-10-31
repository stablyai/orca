import type { VirtualItem } from '@tanstack/react-virtual'

export type CombinedDiffItemAnchor = {
  key: VirtualItem['key']
  offset: number
  gap: number
}

export type CombinedDiffViewImport = {
  scrollTop: number
  anchor?: { key: string; offset: number; fallbackKeys?: readonly string[] } | null
}

export class CombinedDiffExtent {
  private items: readonly VirtualItem[] = []
  private indices = new Map<VirtualItem['key'], number>()
  private source: readonly VirtualItem[] | null = null
  private sourcePrefix = 0
  private anchor: CombinedDiffItemAnchor | null = null
  private pendingImport: CombinedDiffViewImport | null = null
  private depth = 0
  private target = 0
  revision = 0
  leadingSlack = 0
  trailingSlack = 0

  constructor(
    private readonly view: {
      position: () => number
      height: () => number
      project: (items: readonly VirtualItem[], height: number, leading: number) => void
      write: (position: number) => void
    }
  ) {}

  item(index: number): VirtualItem | undefined {
    const item = this.items[index]
    return item && this.leadingSlack
      ? { ...item, start: item.start + this.leadingSlack, end: item.end + this.leadingSlack }
      : item
  }

  logicalScrollTop(): number {
    return this.target - this.leadingSlack
  }

  capture(index: number, offset: number): CombinedDiffItemAnchor | null {
    const item = this.item(index)
    return item ? { key: item.key, offset, gap: item.start + offset - this.view.position() } : null
  }

  private topAnchor(priority?: VirtualItem['key']): CombinedDiffItemAnchor | null {
    const position = this.view.position() - this.leadingSlack
    const priorityIndex = priority === undefined ? undefined : this.indices.get(priority)
    const focused = priorityIndex === undefined ? undefined : this.items[priorityIndex]
    let low = 0
    let high = this.items.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (this.items[middle]!.end <= position) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    const item =
      focused && focused.end > position && focused.start < position + this.view.height()
        ? focused
        : this.items[low]
    return item
      ? {
          key: item.key,
          offset: Math.max(0, position - item.start),
          gap: Math.max(0, item.start - position)
        }
      : null
  }

  publish(items: readonly VirtualItem[], priority?: VirtualItem['key'], prefix = 0): void {
    if (items === this.source && prefix === this.sourcePrefix) {
      if (this.pendingImport && this.applyImport()) {
        return
      }
      this.project(this.logicalScrollTop())
      return
    }
    this.source = items
    this.sourcePrefix = prefix
    const changed =
      items.length !== this.items.length ||
      items.some((item, index) => {
        const previous = this.items[index]
        return (
          !previous ||
          item.key !== previous.key ||
          item.size !== previous.size ||
          item.start + prefix !== previous.start
        )
      })
    if (!changed) {
      if (this.pendingImport && this.applyImport()) {
        return
      }
      this.project(this.logicalScrollTop())
      return
    }
    const anchor = this.anchor ?? this.topAnchor(priority)
    const indices = new Map(items.map((item, index) => [item.key, index] as const))
    const fallback =
      anchor && !indices.has(anchor.key)
        ? this.items
            .slice(this.items.findIndex((item) => item.key === anchor.key) + 1)
            .find((item) => indices.has(item.key))
        : undefined
    this.items = items.map((item) => ({
      ...item,
      start: item.start + prefix,
      end: item.end + prefix
    }))
    this.indices = indices
    this.revision += 1
    this.anchor =
      anchor && indices.has(anchor.key)
        ? anchor
        : fallback
          ? { key: fallback.key, offset: 0, gap: anchor?.gap ?? 0 }
          : null
    if (this.pendingImport && this.applyImport()) {
      return
    }
    if (!this.depth) {
      const target = this.position(this.anchor)
      const naturalMax = Math.max(0, (this.items.at(-1)?.end ?? 0) - this.view.height())
      this.apply(target ?? Math.min(this.view.position() - this.leadingSlack, naturalMax))
    }
  }

  private position(anchor: CombinedDiffItemAnchor | null): number | undefined {
    const index = anchor && this.indices.get(anchor.key)
    const item = index === null || index === undefined ? undefined : this.items[index]
    return item && anchor ? item.start + Math.min(item.size, anchor.offset) - anchor.gap : undefined
  }

  private project(target: number): void {
    const extent = this.items.at(-1)?.end ?? 0
    this.leadingSlack = Math.max(0, -target)
    this.trailingSlack = Math.max(0, target - Math.max(0, extent - this.view.height()))
    this.view.project(
      this.items,
      extent + this.leadingSlack + this.trailingSlack,
      this.leadingSlack
    )
  }

  private apply(target: number): boolean {
    this.target = Math.max(0, target)
    this.project(target)
    const before = this.view.position()
    if (before !== this.target) {
      this.view.write(this.target)
    }
    return before !== this.view.position()
  }

  exportView(): CombinedDiffViewImport {
    if (this.pendingImport) {
      return this.pendingImport
    }
    const anchor = this.anchor ?? this.topAnchor()
    const index = anchor ? (this.indices.get(anchor.key) ?? -1) : -1
    const item = this.items[index]
    const position = this.view.position() - this.leadingSlack
    const fallbackKeys: string[] = []
    for (let next = index + 1; next < this.items.length; next += 1) {
      const candidate = this.items[next]!
      if (candidate.start >= position + this.view.height()) {
        break
      }
      fallbackKeys.push(String(candidate.key))
    }
    return {
      scrollTop: this.view.position(),
      anchor:
        anchor && item && typeof anchor.key === 'string'
          ? {
              key: anchor.key,
              offset: position - item.start,
              fallbackKeys
            }
          : null
    }
  }

  importView(state: CombinedDiffViewImport): void {
    this.pendingImport = state
    this.anchor = null
    this.applyImport()
  }

  private applyImport(): boolean {
    const state = this.pendingImport
    if (!state) {
      return false
    }
    const saved = state.anchor
    const item =
      saved &&
      (this.items.find((item) => item.key === saved.key) ??
        this.items.find((item) => saved.fallbackKeys?.includes(String(item.key))))
    if (saved && !item) {
      return false
    }
    if (!saved && (this.items.at(-1)?.end ?? 0) < state.scrollTop + this.view.height()) {
      this.apply(state.scrollTop)
      return true
    }
    this.pendingImport = null
    if (item && saved) {
      this.restore({ key: item.key, offset: item.key === saved.key ? saved.offset : 0, gap: 0 })
    } else {
      this.navigate(state.scrollTop)
    }
    return true
  }

  restore(anchor: CombinedDiffItemAnchor): boolean {
    const target = this.position(anchor)
    if (target === undefined) {
      return false
    }
    this.pendingImport = null
    this.anchor = anchor
    return this.apply(target)
  }

  transact(index: number, delta: number, update: () => boolean | void): boolean {
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
    let valid: boolean
    try {
      valid = update() !== false
    } finally {
      this.depth -= 1
    }
    return valid && this.restore(anchor)
  }

  navigate(target: number): boolean {
    this.pendingImport = null
    const extent = this.items.at(-1)?.end ?? 0
    const max = this.leadingSlack + Math.max(0, extent - this.view.height()) + this.trailingSlack
    const next = Math.max(0, Math.min(max, target)) - this.leadingSlack
    this.anchor = null
    const changed = this.apply(next)
    this.anchor = this.topAnchor()
    return changed
  }

  input(): void {
    this.pendingImport = null
    this.anchor = null
  }

  scrolled(): void {
    const position = this.view.position()
    if (position !== this.target) {
      this.input()
    }
    this.apply(position - this.leadingSlack)
  }

  invalidate(key: VirtualItem['key']): void {
    if (this.anchor?.key === key) {
      this.anchor = null
    }
  }
}
