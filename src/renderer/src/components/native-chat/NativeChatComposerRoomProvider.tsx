import type { ReactNode } from 'react'
import {
  NativeChatRoomContext,
  type useNativeChatComposerMentions
} from './native-chat-composer-room'
import { NativeChatBotChatChooserContext } from './native-chat-room-context'

/** What a composer's `@` list and its bot pills read: the room's members and the chat chooser. */
export function NativeChatComposerRoomProvider({
  mentions,
  children
}: {
  mentions: Pick<ReturnType<typeof useNativeChatComposerMentions>, 'roomContext' | 'chooser'>
  children: ReactNode
}): React.JSX.Element {
  return (
    <NativeChatRoomContext.Provider value={mentions.roomContext}>
      <NativeChatBotChatChooserContext.Provider value={mentions.chooser}>
        {children}
      </NativeChatBotChatChooserContext.Provider>
    </NativeChatRoomContext.Provider>
  )
}
