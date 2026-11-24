export type PeekSide = 'top' | 'bottom' | 'left' | 'right'

/** The card's `w-96`. */
const CARD_WIDTH = 384
export const CARD_OFFSET = 4
export const WINDOW_MARGIN = 8

/** A card asked for beside its link opens on whichever side has room for it, left first, and below
 *  the link when neither does: a card pushed past the window's edge would put its actions out of reach. */
export function sideWithRoom(
  side: PeekSide,
  link: Pick<HTMLElement, 'getBoundingClientRect'> | null,
  windowWidth: number = window.innerWidth
): PeekSide {
  if (side !== 'left' || !link) {
    return side
  }
  const box = link.getBoundingClientRect()
  const needed = Math.min(CARD_WIDTH, windowWidth - 2 * WINDOW_MARGIN) + CARD_OFFSET + WINDOW_MARGIN
  if (box.left >= needed) {
    return 'left'
  }
  return windowWidth - box.right >= needed ? 'right' : 'bottom'
}
