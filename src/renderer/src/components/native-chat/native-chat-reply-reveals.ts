import { createContext, useState } from 'react'
import {
  createNativeChatReplyRevealTracker,
  trackNativeChatReplyRows,
  type NativeChatReplyReveals
} from '../../../../shared/native-chat/transcript/native-chat-reply-reveals'

export type { NativeChatReplyReveals }

/** Absent outside a transcript: such a row neither begins nor is remembered. */
export const NativeChatReplyRevealsContext = createContext<NativeChatReplyReveals | null>(null)

/** Keep reveal state identity stable across renders of this transcript’s current rows. */
export function useNativeChatReplyReveals(
  rowKeys: readonly string[],
  loadedMessageIds: ReadonlySet<string>
): NativeChatReplyReveals {
  const [state] = useState(createNativeChatReplyRevealTracker)
  return trackNativeChatReplyRows(state, rowKeys, loadedMessageIds)
}
