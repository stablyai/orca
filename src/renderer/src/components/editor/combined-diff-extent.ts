import type { VirtualItem } from '@tanstack/react-virtual'
import {
  getCombinedDiffImportedPoint,
  getCombinedDiffRestorationIndex
} from './combined-diff-view-import'
import {
  combinedDiffItemsChanged,
  getCombinedDiffSurvivingAnchor,
  getCombinedDiffTopAnchor,
  getCombinedDiffViewExport
} from './combined-diff-extent-geometry'

export type CombinedDiffExtentItem = VirtualItem & { settled?: boolean; contentGeneration?: number }

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
  private items: readonly CombinedDiffExtentItem[] = []
  private indices = new Map<VirtualItem['key'], number>()
  private source: readonly CombinedDiffExtentItem[] | null = null
  private sourcePrefix = 0
  private anchor: CombinedDiffItemAnchor | null = null
  private anchorGeneration: number | undefined
  private pendingImport: CombinedDiffViewImport | null = null
  private edit: CombinedDiffItemAnchor | null = null
  private target = 0
  private geometry: { height: number; scrollHeight: number; applied: number } | null = null
  revision = 0
  leadingSlack = 0
  trailingSlack = 0

  constructor(
    private readonly view: {
      position: () => number
      height: () => number
      scrollHeight?: () => number
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
    return getCombinedDiffTopAnchor(
      this.items,
      this.indices,
      this.view.position() - this.leadingSlack,
      this.view.height(),
      priority
    )
  }

  publish(
    items: readonly CombinedDiffExtentItem[],
    priority?: VirtualItem['key'],
    prefix = 0
  ): void {
    if (items === this.source && prefix === this.sourcePrefix) {
      if (this.pendingImport && this.applyImport(true)) {
        return
      }
      this.project(this.logicalScrollTop())
      return
    }
    this.source = items
    this.sourcePrefix = prefix
    const changed = combinedDiffItemsChanged(items, this.items, prefix)
    if (!changed) {
      if (this.pendingImport && this.applyImport(true)) {
        return
      }
      this.project(this.logicalScrollTop())
      return
    }
    const anchor = this.anchor ?? this.topAnchor(priority)
    const anchorGeneration = this.anchor
      ? this.anchorGeneration
      : this.items[this.indices.get(anchor?.key ?? '') ?? -1]?.contentGeneration
    const indices = new Map(items.map((item, index) => [item.key, index] as const))
    const nextAnchor = getCombinedDiffSurvivingAnchor(anchor, this.items, indices)
    this.items = items.map((item) => ({
      ...item,
      start: item.start + prefix,
      end: item.end + prefix
    }))
    this.indices = indices
    if (this.edit && !indices.has(this.edit.key)) {
      this.edit = null
    }
    this.revision += 1
    this.anchor = nextAnchor
    if (this.pendingImport && this.applyImport(true)) {
      return
    }
    const anchoredItem = this.anchor && this.items[indices.get(this.anchor.key) ?? -1]
    this.anchorGeneration = anchorGeneration
    if (this.anchor && anchoredItem && anchoredItem.settled !== false) {
      if (
        anchoredItem.contentGeneration !== anchorGeneration &&
        this.anchor.offset > anchoredItem.size
      ) {
        this.anchor = { ...this.anchor, offset: anchoredItem.size }
      }
      this.anchorGeneration = anchoredItem.contentGeneration
    }
    if (!this.edit) {
      const target = this.position(this.anchor)
      const naturalMax = Math.max(0, (this.items.at(-1)?.end ?? 0) - this.view.height())
      this.apply(target ?? Math.min(this.view.position() - this.leadingSlack, naturalMax))
    } else {
      this.project(this.logicalScrollTop())
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
    this.trailingSlack = Math.max(0, target + this.view.height() - extent)
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
    this.geometry = {
      height: this.view.height(),
      scrollHeight: this.view.scrollHeight?.() ?? this.target + this.view.height(),
      applied: this.view.position()
    }
    return before !== this.geometry.applied
  }

  exportView(): CombinedDiffViewImport {
    const anchor = this.anchor ?? this.topAnchor()
    return (
      this.pendingImport ??
      getCombinedDiffViewExport(
        this.items,
        anchor,
        anchor ? (this.indices.get(anchor.key) ?? -1) : -1,
        this.view.position(),
        this.leadingSlack,
        this.view.height()
      )
    )
  }

  importView(state: CombinedDiffViewImport): void {
    this.edit = null
    this.pendingImport = state
    this.anchor = null
    this.applyImport()
  }

  private applyImport(published = false): boolean {
    const state = this.pendingImport
    if (!state) {
      return false
    }
    const point = getCombinedDiffImportedPoint(state, this.items, this.view.height(), published)
    if (!point) {
      return false
    }
    this.anchor = point.anchor
    this.anchorGeneration =
      this.items[this.indices.get(point.anchor?.key ?? '') ?? -1]?.contentGeneration
    this.apply(point.target)
    if (point.settled && this.view.position() === this.target) {
      this.pendingImport = null
      this.anchor = point.anchor ?? this.topAnchor()
    }
    return true
  }

  restorationIndex(): number | undefined {
    return getCombinedDiffRestorationIndex(
      this.pendingImport,
      this.anchor,
      this.items,
      this.indices
    )
  }

  restore(anchor: CombinedDiffItemAnchor): boolean {
    this.edit = null
    const target = this.position(anchor)
    if (target === undefined) {
      return false
    }
    this.pendingImport = null
    this.anchor = anchor
    this.anchorGeneration = this.items[this.indices.get(anchor.key) ?? -1]?.contentGeneration
    return this.apply(target)
  }

  beginEdit(index: number, offset: number) {
    const anchor = this.capture(index, offset)
    if (!anchor) {
      return undefined
    }
    this.pendingImport = null
    this.edit = anchor
    const active = (): boolean => this.edit === anchor
    return {
      active,
      target: (nextOffset: number): number =>
        (this.items[this.indices.get(anchor.key) ?? -1]?.start ?? 0) +
        nextOffset -
        anchor.gap +
        this.leadingSlack,
      commit: (nextOffset: number): boolean =>
        active() && this.restore({ ...anchor, offset: nextOffset }),
      dispose: (): void => {
        if (active()) {
          this.edit = null
        }
      }
    }
  }

  navigate(target: number): boolean {
    this.edit = null
    this.pendingImport = null
    const extent = this.items.at(-1)?.end ?? 0
    const max = this.leadingSlack + Math.max(0, extent - this.view.height()) + this.trailingSlack
    const next = Math.max(0, Math.min(max, target)) - this.leadingSlack
    this.anchor = null
    const changed = this.apply(next)
    this.anchor = this.topAnchor()
    this.anchorGeneration =
      this.items[this.indices.get(this.anchor?.key ?? '') ?? -1]?.contentGeneration
    return changed
  }

  input(): void {
    this.edit = null
    this.pendingImport = null
    this.anchor = null
  }

  dispose(): void {
    this.input()
    this.items = []
    this.indices.clear()
    this.source = null
    this.sourcePrefix = 0
    this.geometry = null
    this.target = 0
    this.leadingSlack = 0
    this.trailingSlack = 0
    this.revision += 1
  }

  scrolled(): void {
    if (this.edit) {
      return
    }
    const position = this.view.position()
    const height = this.view.height()
    const scrollHeight = this.view.scrollHeight?.() ?? this.geometry?.scrollHeight ?? height
    const previous = this.geometry
    const changed =
      !previous || height !== previous.height || scrollHeight !== previous.scrollHeight
    const expected = Math.min(this.target, Math.max(0, scrollHeight - height))
    if (!changed && position !== expected && position !== previous?.applied) {
      this.input()
    }
    if (this.pendingImport && this.applyImport()) {
      return
    }
    this.apply(this.position(this.anchor) ?? position - this.leadingSlack)
  }

  invalidate(key: VirtualItem['key']): void {
    if (this.edit?.key === key) {
      this.edit = null
    }
    if (this.anchor?.key === key) {
      this.anchor = null
    }
  }
}
