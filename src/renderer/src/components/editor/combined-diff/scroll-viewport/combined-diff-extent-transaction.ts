import { CombinedDiffExtentIndex } from './combined-diff-extent-index'
import type { DiffViewportItem } from './combined-diff-viewport-owner'
import type { DiffViewportLayout } from './combined-diff-layout'
import type { CombinedDiffViewportScene } from './combined-diff-viewport-scene'

export class CombinedDiffExtentTransaction {
  readonly index = new CombinedDiffExtentIndex()
  private readonly native = new Set<DiffViewportItem>()
  private readonly extents = new Set<DiffViewportItem>()
  private structure = false
  private all = false

  get pending(): boolean {
    return this.all || this.native.size > 0 || this.extents.size > 0 || this.structure
  }
  invalidate(item?: DiffViewportItem): void {
    if (!item) {
      this.all = true
    } else if (!item.retired) {
      this.native.add(item)
    }
  }
  forget(item: DiffViewportItem): void {
    this.native.delete(item)
    this.extents.delete(item)
  }
  changed(items: readonly DiffViewportItem[], structure: boolean): void {
    this.structure ||= structure
    for (const item of items) {
      this.extents.add(item)
    }
  }
  measure(item: DiffViewportItem, height: number): boolean {
    if (item.retired || height <= 0) {
      return false
    }
    if (height === item.height) {
      const changed = !item.measured
      item.measured = true
      return changed
    }
    item.height = height
    item.measured = true
    this.extents.add(item)
    return true
  }
  commit(input: {
    order: readonly DiffViewportItem[]
    attached: ReadonlySet<DiffViewportItem>
    scene: CombinedDiffViewportScene
    layout: DiffViewportLayout
    top: number
    height: number
    direction: 'up' | 'down' | undefined
    survives(key: string): boolean
  }): { top: number; changed: boolean } {
    const anchor = this.index.captureSizeAnchor(
      input.top,
      input.height,
      input.direction,
      input.survives
    )
    if (input.scene.usable) {
      input.scene.prepare(this.index, input.layout, input.attached)
      const reads = this.all ? input.attached : this.native
      for (const item of reads) {
        if (!item.retired) {
          const height = item.binding?.readHeight()
          if (height !== null && height !== undefined && height > 0) {
            this.measure(item, height)
            item.measured = true
          }
        }
      }
      this.native.clear()
      this.all = false
    }
    const changed = this.index.commit(input.order, input.height, this.extents, this.structure)
    this.structure = false
    this.extents.clear()
    return { changed, top: changed ? this.index.mapSizeAnchor(anchor, input.height) : input.top }
  }
}
