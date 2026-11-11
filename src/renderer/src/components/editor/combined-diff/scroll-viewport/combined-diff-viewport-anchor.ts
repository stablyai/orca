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
  getHeight(): number
  getTop(): number
  setTop(top: number): void
  render(): void
  getDirection(): 'up' | 'down' | undefined
  getVisible(): readonly DiffViewportItem[]
}

export class CombinedDiffViewportAnchor {
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

  beginInput(): void {
    this.readingDirty = true
  }

  importView(anchor: DiffReadingAnchor | null, fallback: number): void {
    this.imported = { anchor, fallback }
    this.context.invalidate()
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
    if (this.imported && this.context.getIndex().length > 0) {
      this.clearPoint()
      this.context.setTop(
        this.imported.anchor
          ? (this.context.getIndex().anchorOffset(this.imported.anchor) ?? this.imported.fallback)
          : this.imported.fallback
      )
      this.imported = null
      this.context.render()
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
    const up = this.context.getDirection() === 'up'
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
}
