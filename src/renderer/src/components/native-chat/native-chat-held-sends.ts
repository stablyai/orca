// A structured send's message is kept beside the chat's live draft, as a held send, from Enter
// until the host holds it. Typing and later sends change only the live draft, so nothing waits on
// the host and nothing is saved over a held send. After a relaunch the chat's journal decides each
// one the earlier run left: dropped when the host holds it, otherwise put back into the box.

import {
  appendNativeChatDraftNow,
  readNativeChatDraftCache,
  readNativeChatDraftHeldSends,
  updateNativeChatDraftHeldSends,
  type NativeChatDraftContent
} from './native-chat-draft-cache'
import { nativeChatDraftStoreSavesSendClearAtOnce } from './native-chat-draft-storage'
import { takeRestoredNativeChatHeldSends } from './native-chat-restored-held-sends'

/**
 * Saves the box a structured send just cleared, with the sent message as a held send under the id
 * the host will know it by, in one write. With no id (nothing reached the outbox) only the box is
 * saved. The web client saved the clear at Enter and holds no copy.
 */
export function holdNativeChatDraftSend(
  draftKey: string,
  sent: NativeChatDraftContent,
  clientMessageId: string | undefined
): void {
  if (nativeChatDraftStoreSavesSendClearAtOnce()) {
    return
  }
  const held = clientMessageId
    ? [
        {
          clientMessageId,
          text: sent.text,
          attachments: sent.attachments ?? [],
          sentAt: Date.now()
        }
      ]
    : []
  updateNativeChatDraftHeldSends(draftKey, (heldSends) => [...heldSends, ...held])
}

/** The host holds this send (or it was withdrawn or dropped): its held copy goes. */
export function releaseNativeChatHeldSend(draftKey: string, clientMessageId: string): void {
  if (
    readNativeChatDraftHeldSends(draftKey).some((send) => send.clientMessageId === clientMessageId)
  ) {
    updateNativeChatDraftHeldSends(draftKey, (heldSends) =>
      heldSends.filter((send) => send.clientMessageId !== clientMessageId)
    )
  }
}

/** A refusal gave the send a new id; the host will know it by that one. */
export function renameNativeChatHeldSend(draftKey: string, from: string, to: string): void {
  if (readNativeChatDraftHeldSends(draftKey).some((send) => send.clientMessageId === from)) {
    updateNativeChatDraftHeldSends(draftKey, (heldSends) =>
      heldSends.map((send) =>
        send.clientMessageId === from ? { ...send, clientMessageId: to } : send
      )
    )
  }
}

/** Drops every held send of the chat the host holds, as its journal shows them. */
export function releaseNativeChatHeldSendsTheHostHolds(
  draftKey: string,
  hostHolds: (clientMessageId: string) => boolean
): void {
  for (const send of readNativeChatDraftHeldSends(draftKey)) {
    if (hostHolds(send.clientMessageId)) {
      releaseNativeChatHeldSend(draftKey, send.clientMessageId)
    }
  }
}

/**
 * The chat's journal answered for the first time since a relaunch: each held send the earlier run
 * left goes back into the box, after anything typed meanwhile, unless the host holds it. Called
 * with `hostHolds` false for every id when the journal cannot be read: shown twice beats lost.
 */
export function settleRestoredNativeChatHeldSends(
  draftKey: string,
  hostHolds: (clientMessageId: string) => boolean
): void {
  // Loads the saved drafts if nothing read them yet, which is what finds the restored sends.
  readNativeChatDraftCache(draftKey)
  const restored = takeRestoredNativeChatHeldSends(draftKey)
  if (!restored) {
    return
  }
  for (const send of readNativeChatDraftHeldSends(draftKey)) {
    if (!restored.has(send.clientMessageId)) {
      continue
    }
    if (hostHolds(send.clientMessageId)) {
      releaseNativeChatHeldSend(draftKey, send.clientMessageId)
      continue
    }
    // The held send leaves in the same write that puts its text back.
    updateNativeChatDraftHeldSends(
      draftKey,
      (heldSends) => heldSends.filter((held) => held.clientMessageId !== send.clientMessageId),
      { save: false }
    )
    void appendNativeChatDraftNow(draftKey, { text: send.text, attachments: send.attachments })
  }
}
