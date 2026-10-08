const MAX_UNFOLDED_LINES = 8
const MAX_UNFOLDED_LENGTH = 600
/** Tailwind's `max-h-44`, which the folded bubble is clipped to. */
export const NATIVE_CHAT_USER_MESSAGE_FOLDED_PX = 176

// Decided from the text alone, so the row's first layout is already its folded one.
export function nativeChatUserMessageFolds(text: string): boolean {
  return text.length > MAX_UNFOLDED_LENGTH || text.split('\n').length > MAX_UNFOLDED_LINES
}
