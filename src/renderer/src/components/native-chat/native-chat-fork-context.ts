import { createContext } from 'react'
import type { NativeChatForkSurface } from './use-native-chat-fork'

/** The fork the pane's responses offer; absent where the chat cannot fork. */
export const NativeChatForkContext = createContext<NativeChatForkSurface | undefined>(undefined)

/** Opens the chat a "Forked from" divider names; absent where the pane cannot open chats. */
export const NativeChatForkedFromContext = createContext<
  ((sourceSessionId: string) => void) | undefined
>(undefined)

/** The pane draws fork actions, so a root response's action row keeps a Fork slot whatever its support. */
export const NativeChatForkSlotContext = createContext(false)
