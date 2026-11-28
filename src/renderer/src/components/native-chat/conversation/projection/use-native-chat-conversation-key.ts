import { useEffect } from 'react'
import { useNativeChatViewMemory } from '../../pane/ownership/native-chat-view-memory'

// Journals a tab keeps its /clear count for: a rewind starts a new one.
const KEPT_CLEAR_COUNTS = 4

/**
 * Names the conversation a chat tab shows: its journal and the live /clears the tab has seen in it. Kept with the
 * tab, because a remounted view counts its own clears from 0; an older /clear found in history changes nothing.
 */
export function useNativeChatConversationKey(epoch: string | null, clears: number): string {
  const { saved, write } = useNativeChatViewMemory<number>(
    `clear-count:${epoch ?? ''}`,
    KEPT_CLEAR_COUNTS
  )
  const seen = (saved ?? 0) + clears
  useEffect(() => write(seen === 0 ? undefined : seen), [write, seen])
  return `${epoch ?? ''}:${seen}`
}
