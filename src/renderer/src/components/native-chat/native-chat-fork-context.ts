import { createContext } from 'react'
import type { NativeChatForkSurface } from './use-native-chat-fork'

/** The fork the pane's answer rows offer; absent where the chat cannot be forked. */
export const NativeChatForkContext = createContext<NativeChatForkSurface | undefined>(undefined)
