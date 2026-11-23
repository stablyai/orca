import { createContext, useState } from 'react'
import {
  createNativeChatReplyRevealTracker,
  keepOnlyNativeChatReveal,
  trackNativeChatReplyRows,
  type NativeChatReplyReveals
} from '../../../../../shared/native-chat/transcript/row-content/native-chat-reply-reveals'

/** The chat a transcript shows, so its replies draw at once only text their own chat held. */
export const NativeChatHeldTextSessionContext = createContext<string | undefined>(undefined)

/** Whether a reply that redraws whole may fall back to its saves: only rows that name an agent
 *  whose saves follow the reply's growth (Claude, Codex). Others (provider timelines save only at
 *  block ends; group turns name no agent) keep showing live text. */
export const NativeChatSaveFallbackContext = createContext(false)

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

/** Reveal memory for the one block an owner outside the transcript rows draws (the live reasoning
 *  line): kept while that block is current, so collapsing and reopening resumes it, a reply's
 *  fallback included, and released once the owner moves to another block. */
export function useNativeChatHeldReveals(key: string | undefined): NativeChatReplyReveals {
  const [reveals] = useState<NativeChatReplyReveals>(() => ({ begun: new Set(), drawn: new Map() }))
  return keepOnlyNativeChatReveal(reveals, key)
}
