// The held sends a relaunch loaded, per chat. They wait for the chat's journal to say whether the
// host holds each; sends made since the relaunch are not among them.

const restoredByChat = new Map<string, Set<string>>()

export function noteRestoredNativeChatHeldSends(
  draftKey: string,
  heldSends: readonly { clientMessageId: string }[] | undefined
): void {
  if (heldSends?.length) {
    restoredByChat.set(draftKey, new Set(heldSends.map((send) => send.clientMessageId)))
  }
}

/** Removes and returns the ids of the chat's restored held sends, so they are judged once. */
export function takeRestoredNativeChatHeldSends(draftKey: string): ReadonlySet<string> | undefined {
  const restored = restoredByChat.get(draftKey)
  restoredByChat.delete(draftKey)
  return restored
}

export function forgetRestoredNativeChatHeldSends(draftKeys: Iterable<string>): void {
  for (const draftKey of draftKeys) {
    restoredByChat.delete(draftKey)
  }
}

export function clearRestoredNativeChatHeldSendsForTests(): void {
  restoredByChat.clear()
}
