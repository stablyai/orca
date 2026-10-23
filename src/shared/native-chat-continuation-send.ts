import { normalizeNativeChatUserText } from './native-chat-image-transcript-markers'

// Agent TUIs may consume the final backslash and join the next send into this turn.
export function nativeChatContinuationSendText(text: string): string | null {
  return text.endsWith('\\') ? normalizeNativeChatUserText(text.slice(0, -1)) : null
}
