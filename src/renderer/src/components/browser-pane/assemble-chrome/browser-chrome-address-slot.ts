/**
 * The height every identity widget in the toolbar's address slot is stretched to.
 *
 * Why the row owns it rather than each widget: an address bar is a text input and a document chip
 * is a line of text, so left to themselves they come out 8px apart and the whole toolbar changes
 * height when the reader switches between a web tab and a document tab. 2.375rem is the address
 * bar's own natural box (its input's line box plus the frame padding), so pinning to it keeps the
 * browser chrome exactly as it looks today and brings every other slot up to match.
 */
export const BROWSER_CHROME_ADDRESS_SLOT_HEIGHT_CLASS = 'h-9.5'

/** Marks the slot wrapper so tests can prove both surfaces share one height contract. */
export const BROWSER_CHROME_ADDRESS_SLOT_ATTRIBUTE = 'data-browser-chrome-address-slot'
