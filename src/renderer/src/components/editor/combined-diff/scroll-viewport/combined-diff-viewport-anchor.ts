import type { DiffReadingAnchor } from './combined-diff-layout'
import type { CombinedDiffExtentIndex } from './combined-diff-extent-index'
import type { DiffViewportItem } from './combined-diff-viewport-owner'

export type DiffSemanticPoint = {
  resolveScrollTop(displacement: number): number | null
  fitScrollTop?(preferredTop: number): number | null
  isValid?(): boolean
  project(): number | null
  projectEnd?(): number | null
  revealDisplacement?(height: number): number | null
  constrainDisplacement?(height: number, displacement: number): number | null
  dispose(): void
}
type CommittedPoint = { point: DiffSemanticPoint; displacement: number }
type AnchorContext = {
  invalidate(): void
  getIndex(): CombinedDiffExtentIndex
  getItem(key: string): DiffViewportItem | undefined
  itemsReady(): boolean
  canApply(): boolean
  getHeight(): number
  getTop(): number
  setTop(top: number): void
  render(): void
  getVisible(): readonly DiffViewportItem[]
}

export class CombinedDiffViewportAnchor {
  direction: 'up' | 'down' | undefined
  private directionTimer = 0
  private committed: CommittedPoint | null = null
  private readingDirty = false
  private pending: {
    item: DiffViewportItem
    resolve: () => DiffSemanticPoint | null
    focus?: () => void
    point?: DiffSemanticPoint
  } | null = null
  private imported: { anchor: DiffReadingAnchor | null; fallback: number } | null = null
  constructor(private readonly context: AnchorContext) {}

  beginInput(delta: number): void {
    this.readingDirty = true
    if (delta !== 0) {
      this.direction = delta < 0 ? 'up' : 'down'
      clearTimeout(this.directionTimer)
      this.directionTimer = window.setTimeout(() => {
        this.direction = undefined
      }, 100)
    }
  }

  importView(anchor: DiffReadingAnchor | null, fallback: number): void {
    this.cancelNavigation()
    this.clearPoint()
    this.imported = { anchor, fallback }
    this.context.invalidate()
  }

  getViewMemory(): { scrollAnchor: DiffReadingAnchor | null; scrollTop: number } | null {
    return this.imported
      ? { scrollAnchor: this.imported.anchor, scrollTop: this.imported.fallback }
      : null
  }

  preserve(point: DiffSemanticPoint, displacement = point.project()): void {
    if (displacement === null) {
      point.dispose()
      return
    }
    if (this.committed?.point !== point) {
      this.clearPoint()
    }
    this.readingDirty = false
    this.committed = { point, displacement }
  }

  reveal(
    item: DiffViewportItem,
    resolve: () => DiffSemanticPoint | null,
    focus?: () => void,
    point?: DiffSemanticPoint
  ): void {
    this.cancelNavigation()
    this.pending = { item, resolve, focus, point }
    this.context.invalidate()
  }

  cancelNavigation(): void {
    this.pending?.point?.dispose()
    this.pending = null
    this.imported = null
  }
  cancelItemNavigation(item: DiffViewportItem): void {
    if (this.pending?.item === item) {
      this.pending.point?.dispose()
      this.pending = null
    }
  }

  reconcile(): (() => void) | undefined {
    let navigation: typeof this.pending = null
    if (this.imported && !this.applyImport()) {
      return
    }
    if (!this.context.canApply()) {
      return
    }
    const pending = this.pending
    if (
      pending &&
      !pending.item.retired &&
      pending.item.binding &&
      pending.item.binding.readHeight() !== null
    ) {
      const point = pending.point ?? pending.resolve()
      if (point) {
        pending.point = point
      }
      if (point?.isValid && !point.isValid()) {
        this.cancelItemNavigation(pending.item)
      } else if (point) {
        const projected = point.project()
        if (projected !== null) {
          const top =
            point.revealDisplacement?.(this.context.getHeight()) ??
            Math.max(0, Math.min(projected, this.context.getHeight() - 24))
          this.preserve(point, top)
          navigation = pending
        }
      }
    }
    const settled = this.readingDirty ? false : this.applyPoint()
    if (navigation && settled) {
      navigation.point = undefined
      this.pending = null
    }
    this.captureReadingPoint()
    return settled ? navigation?.focus : undefined
  }

  private applyImport(): boolean {
    const imported = this.imported!
    const index = this.context.getIndex()
    const anchor = imported.anchor ?? index.anchorAt(imported.fallback)
    const position = anchor ? index.position(anchor.key) : undefined
    const item = anchor ? this.context.getItem(anchor.key) : undefined
    if (position === undefined || !item) {
      const complete = this.context.itemsReady()
      this.context.setTop(
        complete
          ? Math.max(0, Math.min(imported.fallback, index.total - this.context.getHeight()))
          : imported.fallback
      )
      this.context.render()
      if (!complete) {
        return false
      }
      this.imported = null
      return true
    }
    const height = index.heightAt(position)
    const ready =
      item.collapsed ||
      (item.bodyKind === 'native'
        ? item.binding?.readHeight() !== null && item.binding !== null
        : item.bodyKind !== 'pending' && (item.measured || item.bodyKind === undefined))
    // Keep an estimated short target in view so its normal body can materialize.
    const offset =
      !ready && anchor!.offset >= height
        ? Math.max(0, height - this.context.getHeight())
        : Math.min(anchor!.offset, height)
    const requested = index.startAt(position) + offset
    this.context.setTop(requested)
    this.context.render()
    if (!ready || !this.context.canApply()) {
      return false
    }
    const applied = this.context.getTop()
    const bounded = Math.max(0, Math.min(requested, index.total - this.context.getHeight()))
    const outerLanded = Math.abs(applied - requested) < 1 || Math.abs(applied - bounded) < 1
    const finalFallback = anchor!.offset >= height
    if (
      !outerLanded ||
      (!finalFallback && item.bodyKind === 'native' && !item.binding?.isScrollApplied?.())
    ) {
      return false
    }
    this.imported = null
    return true
  }

  private applyPoint(): boolean {
    const anchor = this.committed
    if (!anchor) {
      return false
    }
    if (anchor.point.isValid && !anchor.point.isValid()) {
      this.clearPoint()
      return false
    }
    anchor.displacement =
      anchor.point.constrainDisplacement?.(this.context.getHeight(), anchor.displacement) ??
      anchor.displacement
    const resolved = anchor.point.resolveScrollTop(anchor.displacement)
    const top =
      resolved === null
        ? null
        : anchor.point.fitScrollTop
          ? anchor.point.fitScrollTop(resolved)
          : resolved
    if (top === null) {
      return false
    }
    if (top !== this.context.getTop()) {
      this.context.setTop(top)
      this.context.render()
    }
    const applied = anchor.point.project()
    if (applied !== null && Math.abs(applied - anchor.displacement) >= 1) {
      const next = anchor.point.resolveScrollTop(anchor.displacement)
      const confirmed =
        next === null ? null : anchor.point.fitScrollTop ? anchor.point.fitScrollTop(next) : next
      if (confirmed !== null && confirmed !== this.context.getTop()) {
        this.context.setTop(confirmed)
        this.context.render()
      }
    }
    return true
  }

  private captureReadingPoint(): void {
    if ((!this.readingDirty && this.committed) || this.pending) {
      return
    }
    const previous = this.committed?.point
    this.readingDirty = false
    const up = this.direction === 'up'
    const edge = up ? this.context.getHeight() : 0
    const offset = this.context.getTop() + edge
    const extents = this.context.getIndex()
    const item = this.context.getVisible().find((candidate) => {
      const index = extents.position(candidate.key)
      if (index === undefined || extents.heightAt(index) <= 0) {
        return false
      }
      const start = extents.startAt(index)
      const end = start + extents.heightAt(index)
      return up ? start < offset && offset <= end : start <= offset && offset < end
    })
    const point = item?.binding?.capture(edge, previous)
    if (point) {
      this.preserve(point)
      return
    }
    this.clearPoint()
  }
  clearPoint(): void {
    this.committed?.point.dispose()
    this.committed = null
    this.readingDirty = false
  }
  dispose(): void {
    this.cancelNavigation()
    this.clearPoint()
    clearTimeout(this.directionTimer)
  }
}
