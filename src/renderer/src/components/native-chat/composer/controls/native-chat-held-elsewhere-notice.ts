// A message refused because files it names are in another chat's draft says so where it was refused,
// and stays until dismissed or the next send there: a toast would vanish before the person looked.

/** Files a refused message named that another chat's draft holds now, and that chat. */
export type NativeChatHeldElsewhere = {
  count: number
  /** The one conversation whose draft holds them all; absent when no chat (a pending creation) does. */
  ownerSessionId?: string
  /** Drafts of more than one chat hold them, so no single chat is named. */
  severalChats?: true
}

const notices = new Map<string, NativeChatHeldElsewhere>()
const listeners = new Map<string, Set<() => void>>()

function notify(sessionId: string): void {
  for (const listener of listeners.get(sessionId) ?? []) {
    listener()
  }
}

/** Record (or with null, clear) why this chat's last refused message didn't go. */
export function noteNativeChatFilesHeldElsewhere(
  sessionId: string,
  held: NativeChatHeldElsewhere | null
): void {
  const current = notices.get(sessionId)
  if (!held) {
    if (current) {
      notices.delete(sessionId)
      notify(sessionId)
    }
    return
  }
  if (
    current?.count === held.count &&
    current.ownerSessionId === held.ownerSessionId &&
    current.severalChats === held.severalChats
  ) {
    return
  }
  notices.set(sessionId, held)
  notify(sessionId)
}

export function readNativeChatHeldElsewhere(sessionId: string): NativeChatHeldElsewhere | null {
  return notices.get(sessionId) ?? null
}

export function subscribeToNativeChatHeldElsewhere(
  sessionId: string,
  listener: () => void
): () => void {
  const scoped = listeners.get(sessionId) ?? new Set()
  scoped.add(listener)
  listeners.set(sessionId, scoped)
  return () => {
    scoped.delete(listener)
    if (scoped.size === 0) {
      listeners.delete(sessionId)
    }
  }
}

export function resetNativeChatHeldElsewhereForTests(): void {
  notices.clear()
  listeners.clear()
}
