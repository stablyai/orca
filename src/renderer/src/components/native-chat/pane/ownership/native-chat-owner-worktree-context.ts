import { createContext } from 'react'

/** Owning workspace of the chat pane; null where transcript rows render without one. */
export const NativeChatOwnerWorktreeContext = createContext<string | null>(null)
