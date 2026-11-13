import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import {
  advancedNativeChatUserContentCounts,
  matchingNativeChatUserContentCounts,
  nativeChatPendingContentKey
} from '../../../../../shared/native-chat/transcript/native-chat-pending-occurrence'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

export type NativeChatLaunchPrompt = {
  tabId: string
  agent: TuiAgent
  text: string
  createdAt: number
  failed?: boolean
}

/** Keep unsent launch context as a composer draft so TUI-prefilled linked context remains visible in chat. */
export type NativeChatLaunchDraft = {
  tabId: string
  agent: TuiAgent
  text: string
  createdAt: number
  /** Set once a composer copied the text into its draft; blocks re-adoption after the user clears it. */
  adopted?: boolean
  /** Accepted mobile submission consumed the TUI-side copy. */
  resolved?: boolean
  /** Read off the input line where the user typed it, rather than typed there by Orca. */
  fromTerminal?: boolean
  /** Text of the adopted seed this one replaces; a composer still holding it takes the new text. */
  replacesText?: string
}

// Synthetic launch ids never match real turns; reconcile normalized user text instead.
export function launchPromptAsMessage(
  entry: NativeChatLaunchPrompt | null,
  existingMessages: NativeChatMessage[] = []
): NativeChatMessage | null {
  if (!entry) {
    return null
  }
  // A new session’s timestampless matching row can only represent its launch prompt.
  const represented = matchingNativeChatUserContentCounts(
    existingMessages.filter(
      (message) => message.timestamp === null || message.timestamp >= entry.createdAt
    )
  )
  if ((represented.get(nativeChatPendingContentKey(entry)) ?? 0) > 0) {
    return null
  }
  return {
    id: `launch-pending:${entry.tabId}`,
    role: 'user' as const,
    blocks: entry.text.trim().length > 0 ? [{ type: 'text' as const, text: entry.text }] : [],
    timestamp: entry.createdAt,
    source: 'scrape' as const
  }
}

// Wait for a later non-user turn to avoid a first-turn flash before the transcript catches up.
export function shouldPruneLaunchPrompt(
  entry: NativeChatLaunchPrompt,
  messages: NativeChatMessage[]
): boolean {
  const relevant = messages.filter(
    (message) => message.timestamp === null || message.timestamp >= entry.createdAt
  )
  return (
    (advancedNativeChatUserContentCounts(relevant).get(nativeChatPendingContentKey(entry)) ?? 0) > 0
  )
}
