// Cards opened from the item's details stay inside the item pane: at a narrow pane the window's edge is
// past the pane's, and a card sized to the window would cover the pane beside it.
import { WINDOW_MARGIN, type PeekBounds } from '../../native-chat/links/previews/link-peek-side'

/** The item pane holding `node`, as a card's boundary, and the widest a card may be inside it. */
export function botItemPaneBounds(node: Element): PeekBounds | null {
  const pane = node.closest('[data-bot-item-pane]')
  return pane ? { boundary: pane, maxWidth: pane.clientWidth - 2 * WINDOW_MARGIN } : null
}

export { WINDOW_MARGIN as BOT_ITEM_PANE_CARD_MARGIN }
