// Where the item's details may be cut when the cap they share with the title is shorter than they are.
// Legal cuts: the end of a block, the end of a whole link row, or the end of a whole visible line of
// text (all its runs). A labeled block (its first child an h3) is never cut between its label and its
// first line, unless that first unit is far taller than the room.

/** A link row: cut only after it whole, never through its text. */
const ROW_ATTRIBUTE = 'data-bot-item-cut'

/** Every legal cut in `column`, as offsets from its top, and its full height. */
export type BotItemDetailsGeometry = { cuts: number[]; height: number }

/** How far past the room a first block's label and first line may still be shown whole; a first unit
 *  taller than that (a tall image, a long unbroken first line) is cut at the room under the fade. */
const FIRST_UNIT_OVERSHOOT = 24

/** How much of the details to show in `room`. All of it when it fits; else up to the last legal cut
 *  that fits, rounded up so the cut never lands above a measured line; else the first legal cut (a
 *  block's label and first line together) when it is at most `FIRST_UNIT_OVERSHOOT` past the room;
 *  else the room. */
export function pickBotItemDetailsCut(geometry: BotItemDetailsGeometry, room: number): number {
  const fits = Math.max(0, room)
  if (geometry.height <= fits) {
    return Math.floor(fits)
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
    return Math.ceil(below)
  }
  return first - fits <= FIRST_UNIT_OVERSHOOT ? Math.ceil(first) : Math.floor(fits)
}

type LineExtent = { top: number; bottom: number; visibleTo: number }

/** The legal cuts of the details column, read from layout: blocks are its children. A line's text
 *  can sit in several runs (code, a link, a superscript) whose boxes end at different heights, so runs
 *  whose boxes overlap are one line, which ends at its lowest run. A line any clip cuts is no cut. */
export function readBotItemDetailsGeometry(column: HTMLElement): BotItemDetailsGeometry {
  const top = column.getBoundingClientRect().top
  const cuts: number[] = []
  const clips = new Map<Element, number>()
  const range = document.createRange()
  for (const block of column.children) {
    cuts.push(block.getBoundingClientRect().bottom - top)
    const label = block.firstElementChild?.tagName === 'H3' ? block.firstElementChild : null
    for (const row of block.querySelectorAll(`[${ROW_ATTRIBUTE}="row"]`)) {
      cuts.push(row.getBoundingClientRect().bottom - top)
    }
    const runs: LineExtent[] = []
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
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
      const visibleTo = visibleBottom(parent, block, clips)
      range.selectNodeContents(node)
      for (const box of range.getClientRects()) {
        if (box.height > 0) {
          runs.push({ top: box.top, bottom: box.bottom, visibleTo })
        }
      }
    }
    for (const line of mergeLines(runs)) {
      if (line.bottom <= line.visibleTo + 0.5) {
        cuts.push(line.bottom - top)
      }
    }
  }
  return { cuts, height: column.offsetHeight }
}

/** Runs whose boxes overlap vertically, merged into whole lines. */
function mergeLines(runs: LineExtent[]): LineExtent[] {
  const lines: LineExtent[] = []
  for (const run of [...runs].sort((a, b) => a.top - b.top)) {
    const line = lines.at(-1)
    if (line && run.top < line.bottom - 0.5) {
      line.bottom = Math.max(line.bottom, run.bottom)
      line.visibleTo = Math.min(line.visibleTo, run.visibleTo)
    } else {
      lines.push({ ...run })
    }
  }
  return lines
}

/** Where `element`'s text stops showing: the lowest edge every clipping ancestor within `block` (a
 *  clamp) leaves visible; Infinity when none clips. */
function visibleBottom(element: Element, block: Element, clips: Map<Element, number>): number {
  const cached = clips.get(element)
  if (cached !== undefined) {
    return cached
  }
  const own =
    getComputedStyle(element).overflowY === 'visible'
      ? Number.POSITIVE_INFINITY
      : element.getBoundingClientRect().bottom
  const outer =
    element === block || !element.parentElement
      ? Number.POSITIVE_INFINITY
      : visibleBottom(element.parentElement, block, clips)
  const bottom = Math.min(own, outer)
  clips.set(element, bottom)
  return bottom
}
