/** A shrinkable part of a one-line row: its full width while it fits, then an even share of what is left.
 *  Every shrinkable part beside a chip needs it, so the chip keeps its width while this gives way. */
export const NATIVE_CHAT_ROW_SHARE = 'min-w-0 max-w-fit flex-1 basis-0 truncate'

/** A floor for a part that cuts short: a few letters, or its whole width when that is less. */
export const NATIVE_CHAT_READABLE_MIN = 'min-w-[calc-size(max-content,min(size,5rem))]'

/** A share that keeps a few letters: it gives way first, but stops before it reads as a stray letter. */
export const NATIVE_CHAT_READABLE_SHARE = `${NATIVE_CHAT_READABLE_MIN} max-w-fit flex-1 basis-0 truncate`

/** A name in a transcript line that opens what it names; item, chat and worker chips share this look.
 *  Chips keep their full width while the row's shares give way, then cut short, never below a few letters. */
export const NATIVE_CHAT_INLINE_CHIP = `inline-flex ${NATIVE_CHAT_READABLE_MIN} items-center gap-1 rounded-md bg-chat-foreground/[0.07] px-1.5 align-middle text-xs leading-5 text-chat-foreground hover:bg-chat-foreground/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`

/** A name in a transcript line that opens nothing; it fits and cuts short as a chip does. */
export const NATIVE_CHAT_INLINE_NAME = `${NATIVE_CHAT_ROW_SHARE} text-chat-foreground`
