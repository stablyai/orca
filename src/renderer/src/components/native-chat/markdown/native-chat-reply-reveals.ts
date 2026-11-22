import { createContext, useState } from 'react'
import {
  createNativeChatReplyRevealTracker,
  trackNativeChatReplyRows,
  type NativeChatReplyReveals
} from '../../../../../shared/native-chat/transcript/row-content/native-chat-reply-reveals'

/** The chat a transcript shows, so its replies draw at once only text their own chat held. */
export const NativeChatHeldTextSessionContext = createContext<string | undefined>(undefined)

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

/** Reveal memory for text drawn outside the transcript rows (the live reasoning line), kept for the
 *  owner's lifetime so collapsing and reopening resumes it, a reply's fallback included. */
export function useNativeChatHeldReveals(): NativeChatReplyReveals {
  const [reveals] = useState<NativeChatReplyReveals>(() => ({ begun: new Set(), drawn: new Map() }))
  return reveals
}
