// One rule for "the reader can see this match", shared by picking a match and revealing it, so
// a match chosen as visible is never scrolled.

type Box = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>

type Clip = { element: Element; scrolls: boolean }

function within(rect: Box, box: Box): boolean {
  return (
    rect.top >= box.top &&
    rect.bottom <= box.bottom &&
    rect.left >= box.left &&
    rect.right <= box.right
  )
}

function overlaps(rect: Box, box: Box): boolean {
  return (
    rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top
  )
}

function outside(rect: Box, box: Box): boolean {
  return (
    rect.bottom < box.top || rect.top > box.bottom || rect.right < box.left || rect.left > box.right
  )
}

export type NativeChatFindGeometry = {
  /** Fully inside the transcript's view and every scroll box around it, and not under the bar. */
  inView: (match: Range, bar: Box | null) => boolean
  /** Cut off by a box that cannot scroll (a folded prompt, a truncated label): never shown. */
  clippedAway: (match: Range) => boolean
  /** Scrolls the nested scroll boxes (code lines, tool output, thinking) to the match. */
  scrollIntoBoxes: (match: Range) => void
}

/** Layout reads for one pass over the matches; style lookups are cached for the pass. */
export function nativeChatFindGeometry(transcript: Element): NativeChatFindGeometry {
  const clipsByElement = new Map<Element, readonly Clip[]>()
  const clipsOf = (element: Element | null): readonly Clip[] => {
    if (!element || element === transcript || !transcript.contains(element)) {
      return []
    }
    const cached = clipsByElement.get(element)
    if (cached) {
      return cached
    }
    const style = getComputedStyle(element)
    const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`
    const outer = clipsOf(element.parentElement)
    const scrolls = /auto|scroll/.test(overflow)
    // A box that clips but holds all its content cuts nothing off; skipping it saves a rect read per match.
    const cuts =
      scrolls ||
      (/hidden|clip/.test(overflow) &&
        (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth))
    const clips = cuts ? [{ element, scrolls }, ...outer] : outer
    clipsByElement.set(element, clips)
    return clips
  }
  const clipsOfMatch = (match: Range): readonly Clip[] =>
    clipsOf(match.startContainer.parentElement)
  return {
    inView: (match, bar) => {
      const rect = match.getBoundingClientRect()
      return (
        within(rect, transcript.getBoundingClientRect()) &&
        !(bar && overlaps(rect, bar)) &&
        clipsOfMatch(match).every(
          (clip) => !clip.scrolls || within(rect, clip.element.getBoundingClientRect())
        )
      )
    },
    clippedAway: (match) => {
      const fixed = clipsOfMatch(match).filter((clip) => !clip.scrolls)
      if (fixed.length === 0) {
        return false
      }
      const rect = match.getBoundingClientRect()
      return fixed.some((clip) => outside(rect, clip.element.getBoundingClientRect()))
    },
    scrollIntoBoxes: (match) => {
      for (const clip of clipsOfMatch(match)) {
        if (!clip.scrolls) {
          continue
        }
        const rect = match.getBoundingClientRect()
        const box = clip.element.getBoundingClientRect()
        if (rect.left < box.left || rect.right > box.right) {
          clip.element.scrollLeft += (rect.left + rect.right) / 2 - (box.left + box.right) / 2
        }
        if (rect.top < box.top || rect.bottom > box.bottom) {
          clip.element.scrollTop += (rect.top + rect.bottom) / 2 - (box.top + box.bottom) / 2
        }
      }
    }
  }
}

/** How far to scroll the transcript so a match sits mid-view, below the bar when the bar is over it. */
export function nativeChatFindScrollDelta(match: Box, view: Box, bar: Box | null): number {
  const underBar = bar !== null && match.left < bar.right && match.right > bar.left
  const top = underBar ? Math.max(view.top, bar.bottom) : view.top
  return (match.top + match.bottom) / 2 - (top + view.bottom) / 2
}
