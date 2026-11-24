// Where the item's details may be cut when the cap they share with the title is shorter than they are.
// Legal cuts: the end of a block, the end of a whole link row, or the end of a whole visible line of
// text. A labeled block (its first child an h3) is never cut between its label and its first line.

/** A link row: cut only after it whole, never through its text. */
const ROW_ATTRIBUTE = 'data-bot-item-cut'

/** Every legal cut in `column`, as offsets from its top, and its full height. */
export type BotItemDetailsGeometry = { cuts: number[]; height: number }

/** How much of the details to show in `room`. All of it when it fits; else up to the last legal cut
 *  that fits; else (the first block's label and first line are taller than the room) its first legal
 *  cut, so a block never shows a label alone or a line cut through. */
export function pickBotItemDetailsCut(geometry: BotItemDetailsGeometry, room: number): number {
  const fits = Math.max(0, Math.floor(room))
  if (geometry.height <= fits) {
    return fits
  }
  let below = 0
  let first = Number.POSITIVE_INFINITY
  for (const cut of geometry.cuts) {
    if (cut <= 0) {
      continue
    }
    first = Math.min(first, cut)
    if (cut <= fits) {
      below = Math.max(below, cut)
    }
  }
  if (below > 0) {
    return Math.floor(below)
  }
  return Number.isFinite(first) ? Math.ceil(first) : fits
}

/** The legal cuts of the details column, read from layout: blocks are its children. */
export function readBotItemDetailsGeometry(column: HTMLElement): BotItemDetailsGeometry {
  const top = column.getBoundingClientRect().top
  const cuts: number[] = []
  const clips = new Map<Element, DOMRect | null>()
  for (const block of column.children) {
    cuts.push(block.getBoundingClientRect().bottom - top)
    const label = block.firstElementChild?.tagName === 'H3' ? block.firstElementChild : null
    for (const row of block.querySelectorAll(`[${ROW_ATTRIBUTE}="row"]`)) {
      cuts.push(row.getBoundingClientRect().bottom - top)
    }
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (
        !parent ||
        !node.textContent?.trim() ||
        label?.contains(parent) ||
        parent.closest(`[${ROW_ATTRIBUTE}="row"]`)
      ) {
        continue
      }
      const clip = visibleBox(parent, block, clips)
      range.selectNodeContents(node)
      for (const line of range.getClientRects()) {
        // Text a clamp hides (a cut description's later lines) is no place to cut.
        if (line.height > 0 && (!clip || line.bottom <= clip.bottom + 0.5)) {
          cuts.push(line.bottom - top)
        }
      }
    }
  }
  return { cuts, height: column.offsetHeight }
}

/** The box of the nearest ancestor within `block` that clips its overflow, if any. */
function visibleBox(
  element: Element,
  block: Element,
  clips: Map<Element, DOMRect | null>
): DOMRect | null {
  const cached = clips.get(element)
  if (cached !== undefined) {
    return cached
  }
  const clipped = getComputedStyle(element).overflowY !== 'visible'
  const box = clipped
    ? element.getBoundingClientRect()
    : element === block || !element.parentElement
      ? null
      : visibleBox(element.parentElement, block, clips)
  clips.set(element, box)
  return box
}
