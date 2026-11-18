// For list tests whose subject is not pacing: text is drawn as it arrives.

import type * as PacedTextModule from './use-native-chat-paced-text'

export async function unpacedTextModule(
  importOriginal: () => Promise<typeof PacedTextModule>
): Promise<typeof PacedTextModule> {
  return {
    ...(await importOriginal()),
    useNativeChatPacedText: (_rowKey, text) => ({ text, revealing: false, fading: false })
  }
}
