/** The ring a reply jump lands with, also kept while the row holds keyboard focus. Drawn around the
 *  whole row, so it never cuts through the row's actions. */
export const NATIVE_CHAT_ROW_LANDING_RING =
  'focus-visible:outline-none after:pointer-events-none after:absolute after:-inset-1 after:rounded-md after:ring-2 after:ring-ring after:opacity-0 data-[native-chat-reply-landed]:after:opacity-100 focus-visible:after:opacity-100'

/** With actions hanging below the row, the ring reaches down around them too. */
export const NATIVE_CHAT_ROW_LANDING_RING_HANGING = 'after:-bottom-6'
