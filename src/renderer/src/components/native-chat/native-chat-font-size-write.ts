import { chatFontSizeForAction, type ChatFontSizeAction } from './native-chat-font-size'
import { writeNativeChatAppearance } from './native-chat-appearance-write'

export function writeNativeChatFontSize(action: Exclude<ChatFontSizeAction, null>): Promise<void> {
  return writeNativeChatAppearance((appearance) => chatFontSizeForAction(appearance, action))
}
