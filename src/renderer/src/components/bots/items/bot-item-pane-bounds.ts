// Cards opened from the item's details stay inside the item pane: at a narrow pane the window's edge is
// past the pane's, and a card sized to the window would cover the pane beside it.
import type { PeekBoundary } from '../../native-chat/links/previews/use-peek-bounds'

/** The item pane holding a card's link, as the card's boundary. */
export const botItemPaneBoundary: PeekBoundary = (node) => node.closest('[data-bot-item-pane]')

export { WINDOW_MARGIN as BOT_ITEM_PANE_CARD_MARGIN } from '../../native-chat/links/previews/link-peek-side'
