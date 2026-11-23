import { useCallback, useContext } from 'react'
import { NativeChatBotChatRoomContext } from './native-chat-room-context'
import type { NativeChatStructuredComposerSend } from './composer/submit/use-native-chat-structured-composer-send'

/** A send that, once the chat took it, tells the chat's room what it named. */
export function useNativeChatRoomSend(
  send: NativeChatStructuredComposerSend
): NativeChatStructuredComposerSend {
  const sent = useContext(NativeChatBotChatRoomContext)?.sent
  return useCallback<NativeChatStructuredComposerSend>(
    async (text, ...rest) => {
      const accepted = await send(text, ...rest)
      if (accepted) {
        sent?.(text)
      }
      return accepted
    },
    [send, sent]
  )
}
