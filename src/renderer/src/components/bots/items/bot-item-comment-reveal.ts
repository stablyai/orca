// Brings an Activity comment card into view: centred, so the sticky header never covers it. A quote's
// jump focuses the card; the comment box's "Replying to" only lights it, so typing stays in the box.

/** Marks a card so a jump can find it. */
export const BOT_ITEM_COMMENT_ATTRIBUTE = 'data-bot-item-comment-id'
/** Set while a card shows its focus ring without focus: `data-flash:` in its classes. */
const BOT_ITEM_COMMENT_FLASH_ATTRIBUTE = 'data-flash'
const FLASH_MS = 1600
const flashTimers = new WeakMap<HTMLElement, number>()

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
  window.clearTimeout(flashTimers.get(target))
  target.setAttribute(BOT_ITEM_COMMENT_FLASH_ATTRIBUTE, '')
  flashTimers.set(
    target,
    window.setTimeout(() => {
      target.removeAttribute(BOT_ITEM_COMMENT_FLASH_ATTRIBUTE)
      flashTimers.delete(target)
    }, FLASH_MS)
  )
}
