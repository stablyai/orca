import { createContext } from 'react'
import type { NativeChatForkSurface } from './use-native-chat-fork'
import type { NativeChatSideChatForkPoint } from './native-chat-side-chat-fork-point'

/** The fork the pane's responses offer; absent where the chat cannot fork. */
export const NativeChatForkContext = createContext<NativeChatForkSurface | undefined>(undefined)

/** Opens the chat a "Forked from" divider names; absent where the pane cannot open chats. */
export const NativeChatForkedFromContext = createContext<
  ((sourceSessionId: string) => void) | undefined
>(undefined)

/** Hears the newest response the drawn transcript offers Fork on, for `/btw`; absent without `/btw`. */
export const NativeChatSideChatForkPointContext = createContext<
  ((point: NativeChatSideChatForkPoint) => void) | undefined
>(undefined)
