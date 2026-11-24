// Brings an Activity comment card into view, centred in the Activity's scroller. A quote's
// jump focuses the card; the comment box's "Replying to" only lights it, so typing stays in the box.

/** Marks a card so a jump can find it. */
export const BOT_ITEM_COMMENT_ATTRIBUTE = 'data-bot-item-comment-id'
/** A card's highlight: `on`, then `fading` as ring and tint ease out (`data-[flash=…]:` in its classes). */
const BOT_ITEM_COMMENT_FLASH_ATTRIBUTE = 'data-flash'
const FLASH_HOLD_MS = 1200
/** Matches the card's fading transition. */
const FLASH_FADE_MS = 600
/** With reduced motion the highlight holds, then goes with no fade. */
const FLASH_STILL_MS = 1600
const flashTimers = new WeakMap<HTMLElement, number>()

function flash(target: HTMLElement, still: boolean): void {
  const later = (ms: number, run: () => void): void => {
    window.clearTimeout(flashTimers.get(target))
    flashTimers.set(target, window.setTimeout(run, ms))
  }
  const end = (): void => {
    target.removeAttribute(BOT_ITEM_COMMENT_FLASH_ATTRIBUTE)
    flashTimers.delete(target)
  }
  target.setAttribute(BOT_ITEM_COMMENT_FLASH_ATTRIBUTE, 'on')
  if (still) {
    later(FLASH_STILL_MS, end)
    return
  }
  later(FLASH_HOLD_MS, () => {
    target.setAttribute(BOT_ITEM_COMMENT_FLASH_ATTRIBUTE, 'fading')
    later(FLASH_FADE_MS, end)
  })
}

export function revealBotItemComment(
  root: ParentNode | null | undefined,
  eventId: string,
  mark: 'focus' | 'flash'
): void {
  const target = root?.querySelector<HTMLElement>(
    `[${BOT_ITEM_COMMENT_ATTRIBUTE}="${CSS.escape(eventId)}"]`
  )
  if (!target) {
    return
  }
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
  if (mark === 'focus') {
    target.focus({ preventScroll: true })
    return
  }
  flash(target, still)
}
