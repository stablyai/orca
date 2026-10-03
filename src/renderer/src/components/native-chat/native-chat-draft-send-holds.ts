// A send empties its chat's box at once but holds back saving that, so a crash before the host has
// the message restores it unsent. Each hold ends with `save`, which writes the chat's draft as it
// is then; sends on a chat are numbered, and a save is skipped while a later send still waits.

export type NativeChatDraftSendHolds = {
  /** Runs `clear` without saving it, unless `saveAtOnce`; returns the hold's `save`. */
  clearForSend: (
    draftKey: string,
    clear: () => void,
    options: { saveAtOnce: boolean }
  ) => () => void
  /** Runs `clear` without saving it; the caller saves the box itself. */
  clearUnsaved: (draftKey: string, clear: () => void) => void
  /** Whether a send is clearing this chat's box right now, so the write waits for `save`. */
  isClearingForSend: (draftKey: string) => boolean
  /** Forgets the holds of chats that ended. */
  forget: (draftKeys: Iterable<string>) => void
  sendsAwaitingForTests: (draftKey: string) => number
  clearForTests: () => void
}

export function createNativeChatDraftSendHolds(
  persist: (draftKey: string) => void
): NativeChatDraftSendHolds {
  const clearing = new Set<string>()
  // Per chat, the sends whose message the host does not have yet, by send order.
  const awaitingByChat = new Map<string, Set<number>>()
  let sequence = 0

  const clearUnsaved = (draftKey: string, clear: () => void): void => {
    clearing.add(draftKey)
    try {
      clear()
    } finally {
      clearing.delete(draftKey)
    }
  }

  return {
    clearForSend: (draftKey, clear, options) => {
      const send = (sequence += 1)
      const awaiting = awaitingByChat.get(draftKey) ?? new Set()
      awaitingByChat.set(draftKey, awaiting.add(send))
      if (options.saveAtOnce) {
        clear()
      } else {
        clearUnsaved(draftKey, clear)
      }
      const save = (): void => {
        if (!awaiting.delete(send)) {
          return
        }
        if (awaiting.size === 0 && awaitingByChat.get(draftKey) === awaiting) {
          awaitingByChat.delete(draftKey)
        }
        // A later send still waiting keeps its own message saved, and saves once the host has it.
        // An earlier one that never lands (held for Retry) holds nothing up.
        if (Array.from(awaiting).some((later) => later > send)) {
          return
        }
        persist(draftKey)
      }
      return save
    },
    clearUnsaved,
    isClearingForSend: (draftKey) => clearing.has(draftKey),
    forget: (draftKeys) => {
      for (const draftKey of draftKeys) {
        awaitingByChat.get(draftKey)?.clear()
        awaitingByChat.delete(draftKey)
      }
    },
    sendsAwaitingForTests: (draftKey) => awaitingByChat.get(draftKey)?.size ?? 0,
    clearForTests: () => {
      awaitingByChat.clear()
    }
  }
}
