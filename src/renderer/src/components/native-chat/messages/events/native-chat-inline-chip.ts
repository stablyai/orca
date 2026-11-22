/** A name in a transcript line that opens what it names; item, chat and worker chips share this look.
 *  Chips keep their full width and cut short together only when the one-line row runs out of width. */
export const NATIVE_CHAT_INLINE_CHIP =
  'inline-flex min-w-0 max-w-fit flex-1 basis-0 items-center gap-1 rounded-md bg-chat-foreground/[0.07] px-1.5 align-middle text-xs leading-5 text-chat-foreground hover:bg-chat-foreground/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** A name in a transcript line that opens nothing; it fits and cuts short as a chip does. */
export const NATIVE_CHAT_INLINE_NAME =
  'min-w-0 max-w-fit flex-1 basis-0 truncate text-chat-foreground'
