// What a send does with its chat's saved draft once the message is out of Orca's hands.

import type { NativeChatDraftAttachment } from './native-chat-draft-cache'
import type { NativeChatSendHandle } from './native-chat-runtime-send'

/** Saves the chat's draft once the terminal has the message: after its scheduled writes ran. */
export function saveNativeChatDraftAfterPtyWrite(
  handle: NativeChatSendHandle | null,
  save: () => void
): void {
  if (!handle) {
    save()
    return
  }
  void (handle.settled ?? new Promise((resolve) => setTimeout(resolve, handle.settleAfterMs))).then(
    save,
    save
  )
}

/** The draft's copy of composer image chips, for putting a message back. */
export function nativeChatDraftAttachmentsOf(
  attachments: readonly NativeChatDraftAttachment[]
): NativeChatDraftAttachment[] {
  return attachments.map(({ id, path, connectionId, location }) => ({
    id,
    path,
    ...(connectionId ? { connectionId } : {}),
    ...(location ? { location } : {})
  }))
}
