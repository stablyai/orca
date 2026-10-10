import { createContext } from 'react'
import type { NativeChatRewindSurface } from './use-native-chat-rewind'

/** The rewind the pane's user rows offer; absent where the chat cannot rewind. */
export const NativeChatRewindContext = createContext<NativeChatRewindSurface | undefined>(undefined)
