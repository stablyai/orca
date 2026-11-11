import {
  diffAnchorOffset,
  type DiffItemExtent,
  type DiffReadingAnchor
} from './combined-diff-layout'
import type { DiffViewportItem } from './combined-diff-viewport-owner'

export type DiffSemanticPoint = {
  resolveScrollTop(displacement: number): number | null
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
  getExtents(): readonly DiffItemExtent[]
  getHeight(): number
  getTop(): number
  setTop(top: number): void
  render(): void
  getDirection(): 'up' | 'down' | undefined
  getOrder(): readonly DiffViewportItem[]
}

export class CombinedDiffViewportAnchor {
  private committed: CommittedPoint | null = null
  private pending: {
    item: DiffViewportItem
    resolve: () => DiffSemanticPoint | null
    focus?: () => void
    point?: DiffSemanticPoint
  } | null = null
  private imported: { anchor: DiffReadingAnchor | null; fallback: number } | null = null
  constructor(private readonly context: AnchorContext) {}

  importView(anchor: DiffReadingAnchor | null, fallback: number): void {
    this.imported = { anchor, fallback }
    this.context.invalidate()
  }

  preserve(point: DiffSemanticPoint, displacement = point.project()): void {
    if (displacement === null) {
      point.dispose()
      return
    }
    this.clearPoint()
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
    let focus: (() => void) | undefined
    if (this.imported && this.context.getExtents().length > 0) {
      this.clearPoint()
      this.context.setTop(
        this.imported.anchor
          ? (diffAnchorOffset(this.context.getExtents(), this.imported.anchor) ??
              this.imported.fallback)
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
          pending.point = undefined
          this.pending = null
          focus = pending.focus
        }
      }
    }
    this.applyPoint()
    this.captureReadingPoint()
    return focus
  }

  private applyPoint(): void {
    const anchor = this.committed
    if (!anchor) {
      return
    }
    if (anchor.point.isValid && !anchor.point.isValid()) {
      this.clearPoint()
      return
    }
    anchor.displacement =
      anchor.point.constrainDisplacement?.(this.context.getHeight(), anchor.displacement) ??
      anchor.displacement
    const top = anchor.point.resolveScrollTop(anchor.displacement)
    if (top === null) {
      this.clearPoint()
      return
    }
    if (top !== this.context.getTop()) {
      this.context.setTop(top)
      this.context.render()
    }
    const applied = anchor.point.project()
    if (applied !== null && Math.abs(applied - anchor.displacement) >= 1) {
      const confirmed = anchor.point.resolveScrollTop(anchor.displacement)
      if (confirmed !== null && confirmed !== this.context.getTop()) {
        this.context.setTop(confirmed)
        this.context.render()
      }
    }
  }

  private captureReadingPoint(): void {
    if (this.committed || this.pending) {
      return
    }
    const edge = this.context.getDirection() === 'up' ? this.context.getHeight() : 0
    const step = this.context.getDirection() === 'up' ? -1 : 1
    for (
      let index = step === 1 ? 0 : this.context.getOrder().length - 1;
      index >= 0 && index < this.context.getOrder().length;
      index += step
    ) {
      const point = this.context.getOrder()[index].binding?.capture(edge)
      if (point) {
        this.preserve(point)
        return
      }
    }
  }
  clearPoint(): void {
    this.committed?.point.dispose()
    this.committed = null
  }
}
