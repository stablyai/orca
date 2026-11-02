import type { AttachmentTextSource } from './attachment-text-source'

export type TextAnchor = { block: number; row: number }

// Only aggregate geometry per byte block survives eviction, never a file-wide line index.
export class AttachmentTextViewport {
  readonly starts: number[] = [0]
  readonly heights: number[] = []
  readonly counts: number[] = []
  constructor(
    readonly source: AttachmentTextSource,
    readonly rowHeight: number,
    readonly height: number,
    readonly revision = 0
  ) {
    for (let block = 0; block < source.blockCount; block++) {
      this.counts.push(source.rowCount(block))
    }
    const logicalTotal = this.counts.reduce((sum, count) => sum + count * rowHeight, 0)
    const blockLimit = logicalTotal < 8_000_000 ? Infinity : (8_000_000 - 1) / source.blockCount
    for (let block = 0; block < source.blockCount; block++) {
      const logical = this.counts[block]! * rowHeight
      this.heights.push(Math.min(logical, blockLimit))
      this.starts.push(this.starts[block]! + this.heights[block]!)
    }
  }
  get total(): number {
    return this.starts.at(-1)!
  }
  restore(
    previous: AttachmentTextViewport | null,
    top: number,
    anchor: TextAnchor,
    atEnd: boolean
  ): number {
    if (previous?.source !== this.source) {
      return 0
    }
    if (
      previous.rowHeight === this.rowHeight &&
      previous.height === this.height &&
      previous.counts.length === this.counts.length &&
      previous.counts.every((count, index) => count === this.counts[index])
    ) {
      return top
    }
    const maximum = Math.max(0, this.total - this.height)
    if (atEnd) {
      return maximum
    }
    // A shrinking committed track may already have clamped the last delivered logical anchor.
    const current =
      top === maximum && previous.position(anchor) > top ? { ...anchor } : previous.anchor(top)
    current.row *= (this.counts[current.block] ?? 1) / (previous.counts[current.block] || 1)
    return Math.max(0, Math.min(maximum, this.position(current)))
  }
  private core(block: number) {
    return {
      logical: Math.max(0, this.counts[block]! * this.rowHeight - this.height),
      physical: Math.max(0, this.heights[block]! - this.height)
    }
  }
  anchor(top: number): TextAnchor {
    let low = 0,
      high = this.heights.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (this.starts[middle]! <= top) {
        low = middle
      } else {
        high = middle - 1
      }
    }
    const local = Math.max(0, top - this.starts[low]!)
    const core = this.core(low)
    const logical =
      local < core.physical
        ? (local * core.logical) / core.physical
        : core.logical + local - core.physical
    return { block: low, row: logical / this.rowHeight }
  }
  position(anchor: TextAnchor): number {
    const block = Math.min(anchor.block, this.heights.length - 1)
    const logical = Math.min(
      this.counts[block]! * this.rowHeight,
      Math.max(0, anchor.row * this.rowHeight)
    )
    const core = this.core(block)
    return (
      this.starts[block]! +
      (logical < core.logical
        ? (logical * core.physical) / core.logical
        : core.physical + logical - core.logical)
    )
  }
  move(anchor: TextAnchor, pixels: number): number {
    let block = anchor.block,
      row = anchor.row + pixels / this.rowHeight
    while (row >= this.counts[block]! && block + 1 < this.heights.length) {
      row -= this.counts[block++]!
    }
    while (row < 0 && block > 0) {
      row += this.counts[--block]!
    }
    return this.position({ block, row })
  }
  rows(top: number): { key: string; text: string; top: number }[] {
    const anchor = this.anchor(top)
    const rows: { key: string; text: string; top: number }[] = []
    let y = top - (anchor.row % 1) * this.rowHeight
    for (
      let block = anchor.block;
      block <= Math.min(anchor.block + 1, this.heights.length - 1);
      block++
    ) {
      const segments = this.source.cachedBlock(block)
      if (!segments) {
        break
      }
      const first = block === anchor.block ? Math.floor(anchor.row) : 0
      for (let row = first; row < segments.length && rows.length < 256; row++) {
        if (y > top + this.height + 4 * this.rowHeight) {
          return rows
        }
        rows.push({ key: `${block}:${row}`, text: segments[row]!, top: y })
        y += this.rowHeight
      }
    }
    return rows
  }
}
