import type {
  DiffItemExtent,
  DiffItemLayout,
  DiffReadingAnchor,
  DiffViewportLayout
} from './combined-diff-layout'

export function findDiffExtentEnd(prefix: readonly number[], offset: number): number {
  let low = 0
  let high = prefix.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (prefix[middle + 1] <= offset) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

type SizeAnchor = {
  anchor: DiffReadingAnchor | null
  displacement: number
  end: boolean
  fallback: number
  affinity: 'start' | 'end'
}

export class CombinedDiffExtentIndex {
  private readonly positions = new Map<string, number>()
  private keys: string[] = []
  private heights: number[] = []
  private full: number[] = [0]
  private capped: number[] = [0]
  private viewportHeight = 0

  get length(): number {
    return this.keys.length
  }
  get total(): number {
    return this.full[this.keys.length]
  }
  position(key: string): number | undefined {
    return this.positions.get(key)
  }
  keyAt(index: number): string | undefined {
    return this.keys[index]
  }
  heightAt(index: number): number {
    return this.heights[index]
  }
  startAt(index: number): number {
    return this.full[index]
  }

  commit(
    items: readonly DiffItemExtent[],
    height: number,
    changed: Iterable<DiffItemExtent>,
    structure: boolean
  ): boolean {
    let first = height === this.viewportHeight ? this.length : 0
    if (structure) {
      this.positions.clear()
      this.keys = []
      this.heights = []
      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        this.positions.set(item.key, index)
        this.keys.push(item.key)
        this.heights.push(item.height)
      }
      this.full.length = items.length + 1
      this.capped.length = items.length + 1
      first = 0
    } else {
      for (const item of changed) {
        const index = this.positions.get(item.key)
        if (index !== undefined && this.heights[index] !== item.height) {
          this.heights[index] = item.height
          first = Math.min(first, index)
        }
      }
    }
    const resized = height !== this.viewportHeight
    this.viewportHeight = height
    if (!structure && !resized && first === this.length) {
      return false
    }
    this.rebuildSuffix(first)
    return true
  }

  rebuildSuffix(first: number): void {
    for (let index = first; index < this.length; index++) {
      this.full[index + 1] = this.full[index] + this.heights[index]
      this.capped[index + 1] =
        this.capped[index] + Math.min(this.heights[index], this.viewportHeight)
    }
  }

  anchorAt(offset: number): DiffReadingAnchor | null {
    if (!this.length) {
      return null
    }
    const index = Math.min(this.length - 1, findDiffExtentEnd(this.full, offset))
    return {
      key: this.keys[index],
      offset: offset >= this.total ? this.heights[index] : offset - this.full[index]
    }
  }
  anchorOffset(anchor: DiffReadingAnchor, affinity: 'start' | 'end' = 'end'): number | null {
    const index = this.positions.get(anchor.key)
    if (index === undefined) {
      return null
    }
    const height = this.heights[index]
    return (
      this.full[index] + (anchor.offset < height ? anchor.offset : affinity === 'end' ? height : 0)
    )
  }
  captureSizeAnchor(
    top: number,
    height: number,
    direction: 'up' | 'down' | undefined,
    survives: (key: string) => boolean
  ): SizeAnchor {
    const edge = Math.max(0, Math.min(top + (direction === 'up' ? height : 0), this.total))
    let anchor = this.anchorAt(edge)
    let displacement = edge - top
    const end = anchor !== null && edge === this.total
    if (anchor && !end && !survives(anchor.key)) {
      const oldIndex = this.positions.get(anchor.key)!
      anchor = null
      for (let index = oldIndex + 1; index < this.length; index++) {
        if (survives(this.keys[index])) {
          anchor = { key: this.keys[index], offset: 0 }
          displacement = this.full[index] - top
          break
        }
      }
    }
    return {
      anchor,
      displacement,
      end,
      fallback: top,
      affinity: direction === 'up' ? 'end' : 'start'
    }
  }
  mapSizeAnchor(anchor: SizeAnchor, height: number): number {
    const mapped = anchor.end
      ? this.total
      : anchor.anchor
        ? this.anchorOffset(anchor.anchor, anchor.affinity)
        : null
    return mapped === null
      ? Math.min(anchor.fallback, Math.max(0, this.total - height))
      : mapped - anchor.displacement
  }

  project(
    logicalTop: number,
    height: number,
    revision: number,
    preserveSlack: boolean
  ): DiffViewportLayout {
    const naturalMax = Math.max(0, this.total - height)
    const leadingSlack = preserveSlack ? Math.max(0, -logicalTop) : 0
    const trailingSlack = preserveSlack ? Math.max(0, logicalTop - naturalMax) : 0
    const scrollHeight = leadingSlack + this.total + trailingSlack
    const scrollTop = Math.max(
      0,
      Math.min(logicalTop + leadingSlack, Math.max(0, scrollHeight - height))
    )
    logicalTop = scrollTop - leadingSlack
    const first = findDiffExtentEnd(this.full, logicalTop)
    const hiddenAbove =
      first === this.length
        ? this.total - this.capped[this.length]
        : this.full[first] -
          this.capped[first] +
          Math.max(
            0,
            Math.min(
              logicalTop - this.full[first],
              this.heights[first] - Math.min(this.heights[first], height)
            )
          )
    const viewport: DiffViewportLayout = {
      revision,
      scrollTop,
      logicalTop,
      logicalHeight: this.total,
      scrollHeight,
      renderedTop: scrollTop - hiddenAbove,
      leadingSlack,
      trailingSlack,
      items: []
    }
    const items: DiffItemLayout[] = []
    for (
      let index = first;
      index < this.length && this.full[index] < logicalTop + height;
      index++
    ) {
      items.push(this.itemLayout(this.keys[index], viewport, height)!)
    }
    return { ...viewport, items }
  }
  itemLayout(
    key: string,
    viewport: DiffViewportLayout,
    height = this.viewportHeight
  ): DiffItemLayout | null {
    const index = this.positions.get(key)
    if (index === undefined) {
      return null
    }
    const start = this.full[index]
    const fullHeight = this.heights[index]
    const renderedHeight = Math.min(fullHeight, height)
    return {
      key,
      start,
      height: fullHeight,
      renderedStart: viewport.leadingSlack + this.capped[index],
      renderedHeight,
      scrollOffset: Math.max(0, Math.min(viewport.logicalTop - start, fullHeight - renderedHeight)),
      visible: start + fullHeight > viewport.logicalTop && start < viewport.logicalTop + height
    }
  }
}
