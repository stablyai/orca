import type { AttachmentTextSource, AttachmentTextWindow } from './attachment-text-source'

export type TextAnchor = { block: number; row: number }

// Source row prefixes are logical; only the whole scrollable track is scaled.
export class AttachmentTextViewport {
  readonly prefixes: number[] = [0]
  readonly counts: number[] = []
  readonly known: boolean[] = []
  readonly scale: number
  readonly total: number
  constructor(
    readonly source: AttachmentTextSource,
    readonly rowHeight: number,
    readonly height: number,
    readonly revision = 0
  ) {
    for (let block = 0; block < source.blockCount; block++) {
      const count = source.rowCount(block)
      this.counts.push(count)
      this.known.push(source.rowKnown(block))
      this.prefixes.push(this.prefixes[block]! + count)
    }
    const logical = this.prefixes.at(-1)! * rowHeight
    const scrollable = Math.max(0, logical - height)
    const physical = Math.min(scrollable, 7_999_999)
    this.scale = scrollable ? physical / scrollable : 1
    this.total = Math.min(logical, height) + physical
  }
  sameGeometry(previous: AttachmentTextViewport): boolean {
    return (
      previous.source === this.source &&
      previous.rowHeight === this.rowHeight &&
      previous.height === this.height &&
      previous.counts.length === this.counts.length &&
      previous.counts.every((count, index) => count === this.counts[index])
    )
  }
  restore(previous: AttachmentTextViewport, top: number): number {
    if (previous.source !== this.source) {
      return 0
    }
    if (this.sameGeometry(previous)) {
      return top
    }
    if (top > 0 && top >= previous.total - previous.height - previous.scale / 2) {
      return Math.max(0, this.total - this.height)
    }
    const anchor = previous.anchor(top)
    if (!previous.known[anchor.block]) {
      anchor.row *= (this.counts[anchor.block] ?? 0) / (previous.counts[anchor.block] || 1)
    }
    return this.position(anchor)
  }
  anchor(top: number): TextAnchor {
    const row = Math.max(
      0,
      Math.min(top, Math.max(0, this.total - this.height)) / this.scale / this.rowHeight
    )
    let low = 0,
      high = this.counts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (this.prefixes[middle]! <= row) {
        low = middle
      } else {
        high = middle - 1
      }
    }
    return { block: low, row: row - this.prefixes[low]! }
  }
  position(anchor: TextAnchor): number {
    const block = Math.min(anchor.block, this.counts.length - 1)
    const logical = (this.prefixes[block]! + Math.max(0, anchor.row)) * this.rowHeight
    return Math.max(0, Math.min(this.total - this.height, logical * this.scale))
  }
  move(anchor: TextAnchor, pixels: number): number {
    return Math.max(
      0,
      Math.min(this.total - this.height, this.position(anchor) + pixels * this.scale)
    )
  }
  get rowBudget(): number {
    return Math.ceil(this.height / this.rowHeight) + 4
  }
  window(top: number): AttachmentTextWindow {
    const anchor = this.anchor(top)
    return {
      ...anchor,
      rows: this.rowBudget,
      ...(!this.known[anchor.block]
        ? { fraction: anchor.row / (this.counts[anchor.block] || 1) }
        : {}),
      tail: top > 0 && top >= this.total - this.height - this.scale / 2
    }
  }
  rows(top: number): { key: string; text: string; top: number }[] {
    const anchor = this.anchor(top)
    const rows: { key: string; text: string; top: number }[] = []
    let y = top - (anchor.row % 1) * this.rowHeight
    for (
      let block = anchor.block;
      block < this.counts.length && rows.length < this.rowBudget;
      block++
    ) {
      const segments = this.source.cachedBlock(block)
      if (!segments) {
        break
      }
      const first = block === anchor.block ? Math.floor(anchor.row) : 0
      for (let row = first; row < segments.length && rows.length < this.rowBudget; row++) {
        rows.push({ key: `${block}:${row}`, text: segments[row]!, top: y })
        y += this.rowHeight
      }
    }
    return rows
  }
}
