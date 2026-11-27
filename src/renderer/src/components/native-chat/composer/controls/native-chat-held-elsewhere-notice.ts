import type { NativeChatComposerDraftOwner } from '../../drafts/native-chat-composer-draft-storage'
import {
  records,
  resolveNativeChatComposerDraftOwner
} from '../../drafts/native-chat-composer-draft-memory'
import { structuredAgentSessionDraftScopeKey } from '../../drafts/native-chat-draft-scope'
// A message refused because files it names are in another chat's draft says so where it was refused,
// and stays until dismissed, the next send or goal there, or the chat closing: a toast would vanish
// before the person looked. It lives in memory only, so a reload starts without it.

/**
 * The browser files a refused message named that another chat's draft held then. Who holds them is
 * not stored: it is read from the drafts each time it is shown (see `nativeChatHeldElsewhereNow`), so
 * a later move, send or removal is told truthfully.
 */
export type NativeChatHeldElsewhereRecord = {
  references: readonly string[]
  owner?: NativeChatComposerDraftOwner
  /** A chat this notice tried and failed to open: it is not offered again. */
  unreachableOwner?: string
}

/** What the drafts say now about those files: how many another chat holds, and which one. */
export type NativeChatHeldElsewhere = {
  count: number
  /** The one conversation whose draft holds them all; absent when no chat (a pending creation) does. */
  ownerSessionId?: string
  /** Drafts of more than one chat hold them, so no single chat is named. */
  severalChats?: true
}

const notices = new Map<string, NativeChatHeldElsewhereRecord>()
const listeners = new Map<string, Set<() => void>>()

function notify(sessionId: string): void {
  for (const listener of listeners.get(sessionId) ?? []) {
    listener()
  }
}

/** Record (or with null, clear) why this chat's last refused message didn't go. */
export function noteNativeChatFilesHeldElsewhere(
  sessionId: string,
  references: readonly string[] | null
): void {
  const current = notices.get(sessionId)
  if (!references?.length) {
    if (current) {
      notices.delete(sessionId)
      notify(sessionId)
    }
    return
  }
  if (
    current &&
    !current.unreachableOwner &&
    current.references.length === references.length &&
    current.references.every((reference, index) => reference === references[index])
  ) {
    return
  }
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  const owner = records.get(scope)?.owner ?? resolveNativeChatComposerDraftOwner(scope)
  notices.set(sessionId, { references: [...references], ...(owner ? { owner } : {}) })
  notify(sessionId)
}

/** Opening `ownerSessionId` from this notice failed: the notice stops offering it. */
export function noteNativeChatHeldOwnerUnreachable(
  sessionId: string,
  ownerSessionId: string
): void {
  const current = notices.get(sessionId)
  if (current && current.unreachableOwner !== ownerSessionId) {
    notices.set(sessionId, { ...current, unreachableOwner: ownerSessionId })
    notify(sessionId)
  }
}

export function readNativeChatHeldElsewhere(
  sessionId: string
): NativeChatHeldElsewhereRecord | null {
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

export function nativeChatHeldElsewhereRecordCountForTests(): number {
  return notices.size
}

export function resetNativeChatHeldElsewhereForTests(): void {
  notices.clear()
  listeners.clear()
}

export function retireNativeChatHeldElsewhereWhere(
  matches: (scope: string, owner: NativeChatComposerDraftOwner | undefined) => boolean
): void {
  for (const [sessionId, record] of notices) {
    if (
      matches(
        structuredAgentSessionDraftScopeKey(sessionId),
        record.owner ?? records.get(structuredAgentSessionDraftScopeKey(sessionId))?.owner
      )
    ) {
      noteNativeChatFilesHeldElsewhere(sessionId, null)
    }
  }
}
