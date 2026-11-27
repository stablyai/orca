import { chatFontSizeForAction, type ChatFontSizeAction } from './native-chat-font-size'
import { writeNativeChatAppearance } from './native-chat-appearance-write'

export async function writeNativeChatFontSize(
  action: Exclude<ChatFontSizeAction, null>
): Promise<void> {
  await writeNativeChatAppearance((appearance) => chatFontSizeForAction(appearance, action))
}
