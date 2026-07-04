export const NATIVE_CHAT_USER_MESSAGE_COLLAPSE_LINE_THRESHOLD = 8
export const NATIVE_CHAT_USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD = 600

export function shouldCollapseNativeChatUserMessage(text: string): boolean {
  if (text.length > NATIVE_CHAT_USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD) {
    return true
  }
  return text.split(/\r\n|\r|\n/).length > NATIVE_CHAT_USER_MESSAGE_COLLAPSE_LINE_THRESHOLD
}
