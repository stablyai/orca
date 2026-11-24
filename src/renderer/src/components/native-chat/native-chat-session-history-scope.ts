import { createContext } from 'react'

/** What `/resume` opens: a conversation's own agent history, resumable in place, or a room's
 *  whole home-workspace history, where a picked conversation opens in its own tab. */
export type NativeChatSessionHistoryScope = 'conversation' | 'workspace'

export const NativeChatSessionHistoryScopeContext =
  createContext<NativeChatSessionHistoryScope>('conversation')
