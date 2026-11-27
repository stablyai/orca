import { useEffect } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { nativeChatRowCopyText } from '../native-chat/messages/actions/native-chat-message-copy-text'

/** The rows a room draws, by owner (each turn, and the room's own posts), so the shared chat menu
 *  copies any of them as a chat tab copies its rows. */
export class BotGroupTranscriptRows {
  private readonly byOwner = new Map<string, readonly NativeChatMessage[]>()

  set(owner: string, messages: readonly NativeChatMessage[]): () => void {
    this.byOwner.set(owner, messages)
    return () => {
      if (this.byOwner.get(owner) === messages) {
        this.byOwner.delete(owner)
      }
    }
  }

  messageCopyText = (messageId: string): string | null => {
    for (const messages of this.byOwner.values()) {
      const message = messages.find((entry) => entry.id === messageId)
      if (message) {
        return nativeChatRowCopyText(message)
      }
    }
    return null
  }
}

export function useBotGroupTranscriptRows(
  rows: BotGroupTranscriptRows,
  owner: string,
  messages: readonly NativeChatMessage[]
): void {
  useEffect(() => rows.set(owner, messages), [rows, owner, messages])
}
