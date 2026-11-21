import { useEffect } from 'react'
import { useNativeChatViewState } from '../../pane/ownership/native-chat-view-memory'

// Journals a tab keeps its latest /clear for: a rewind starts a new one.
const KEPT_CLEAR_FLOORS = 4

/**
 * Names the conversation a chat tab shows: its journal and the latest /clear the tab has seen in it. Kept with the
 * tab, because a remounted view may load only rows past that /clear's divider.
 */
export function useNativeChatConversationKey(epoch: string | null, clearFloor: number): string {
  const [seenFloor, setSeenFloor] = useNativeChatViewState(
    `clear-floor:${epoch ?? ''}`,
    0,
    KEPT_CLEAR_FLOORS
  )
  const floor = Math.max(clearFloor, seenFloor)
  useEffect(() => {
    if (floor > seenFloor) {
      setSeenFloor(floor)
    }
  }, [floor, seenFloor, setSeenFloor])
  return `${epoch ?? ''}:${floor}`
}
