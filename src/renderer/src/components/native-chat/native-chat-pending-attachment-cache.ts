// A composer's chips still on their way (a save, an upload, a server's answer), per pane scope,
// owned here rather than by the composer. A prompt card unmounts the composer, so anything owed to
// the message must outlive it: the composer that comes back shows the same chips, Send waits for
// them, and each settles into the scope's draft whichever composer, if any, is showing. They are
// never saved with the draft, so a restored draft cannot bring back an upload as if it were
// attached. Every chip dies with its operation: settled or dropped when the save or upload settles
// (each bounded by its call timeout), removed by the user, or dropped with the drafts of a tab or
// workspace the user closed or removed, so none settles into a draft nothing could find or delete.

import { useCallback, useSyncExternalStore } from 'react'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { NativeChatComposerDraftOwner } from './native-chat-composer-draft-storage'
import {
  appendToNativeChatComposerDraft,
  nativeChatDraftScopeTabId,
  resolveNativeChatComposerDraftOwner,
  structuredAgentSessionIdOfDraftScope
} from './native-chat-composer-draft-store'

const EMPTY: readonly NativeChatComposerImageAttachment[] = Object.freeze([])
const pendingCache = new Map<string, readonly NativeChatComposerImageAttachment[]>()
// Why: a chip can outlive its tab, which is what names the draft's owner, so it is named at once.
const pendingOwners = new Map<string, NativeChatComposerDraftOwner>()
const listeners = new Map<string, Set<() => void>>()

/** The scope's pending chips; the same array until they change, so a reader can subscribe to it. */
export function nativeChatPendingAttachmentSnapshot(
  scopeKey: string
): readonly NativeChatComposerImageAttachment[] {
  return pendingCache.get(scopeKey) ?? EMPTY
}

function writePending(scopeKey: string, next: readonly NativeChatComposerImageAttachment[]): void {
  if (next.length === 0) {
    pendingCache.delete(scopeKey)
    pendingOwners.delete(scopeKey)
  } else {
    pendingCache.set(scopeKey, next)
  }
  listeners.get(scopeKey)?.forEach((listener) => listener())
}

export function subscribeToNativeChatPendingAttachments(
  scopeKey: string,
  listener: () => void
): () => void {
  const scoped = listeners.get(scopeKey) ?? new Set()
  listeners.set(scopeKey, scoped)
  scoped.add(listener)
  return () => {
    scoped.delete(listener)
    if (scoped.size === 0 && listeners.get(scopeKey) === scoped) {
      listeners.delete(scopeKey)
    }
  }
}

/** The scope's pending chips, re-rendering when they change. */
export function useNativeChatPendingAttachments(
  scopeKey: string
): readonly NativeChatComposerImageAttachment[] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatPendingAttachments(scopeKey, listener),
    [scopeKey]
  )
  return useSyncExternalStore(subscribe, () => nativeChatPendingAttachmentSnapshot(scopeKey))
}

/** Adds a chip still on its way. Preview URLs stay with the composer that minted them. */
export function addNativeChatPendingAttachment(
  scopeKey: string,
  chip: NativeChatComposerImageAttachment
): void {
  const { previewUrl: _previewUrl, ...pending } = chip
  const owner = resolveNativeChatComposerDraftOwner(scopeKey) ?? pendingOwners.get(scopeKey)
  if (owner) {
    pendingOwners.set(scopeKey, owner)
  }
  writePending(scopeKey, [...nativeChatPendingAttachmentSnapshot(scopeKey), pending])
}

/** Removes a pending chip and returns it; undefined when the user already removed it. */
export function takeNativeChatPendingAttachment(
  scopeKey: string,
  id: string
): NativeChatComposerImageAttachment | undefined {
  const current = nativeChatPendingAttachmentSnapshot(scopeKey)
  const taken = current.find((attachment) => attachment.id === id)
  if (taken) {
    writePending(
      scopeKey,
      current.filter((attachment) => attachment !== taken)
    )
  }
  return taken
}

/** Settles a pending chip into the scope's draft, as an image the user attached. False when the
 *  user already removed it. */
export function settleNativeChatPendingAttachment(
  scopeKey: string,
  id: string,
  path: string,
  connectionId?: string | null
): boolean {
  const owner = pendingOwners.get(scopeKey)
  if (!takeNativeChatPendingAttachment(scopeKey, id)) {
    return false
  }
  appendToNativeChatComposerDraft(
    scopeKey,
    { images: [{ id, path, ...(connectionId ? { connectionId } : {}) }], fromUser: true },
    owner
  )
  return true
}

/** Shows a pending chip that was held out of sight, such as while a server was asked first. */
export function revealNativeChatPendingAttachment(scopeKey: string, id: string): void {
  const current = nativeChatPendingAttachmentSnapshot(scopeKey)
  if (current.some((attachment) => attachment.id === id && attachment.hidden)) {
    writePending(
      scopeKey,
      current.map((attachment) => {
        const { hidden: _hidden, ...shown } = attachment
        return attachment.id === id ? shown : attachment
      })
    )
  }
}

export function clearNativeChatPendingAttachments(scopeKey: string): void {
  if (pendingCache.has(scopeKey)) {
    writePending(scopeKey, [])
  }
}

function dropPendingWhere(
  matches: (scopeKey: string, owner: NativeChatComposerDraftOwner | undefined) => boolean
): void {
  for (const scopeKey of pendingCache.keys()) {
    if (matches(scopeKey, pendingOwners.get(scopeKey))) {
      writePending(scopeKey, [])
    }
  }
}

/** The chips of every pane in a closed tab, matched as its drafts are; never a conversation's. */
export function dropNativeChatPendingAttachmentsForTab(tabId: string): void {
  dropPendingWhere(
    (scopeKey) =>
      structuredAgentSessionIdOfDraftScope(scopeKey) === null &&
      nativeChatDraftScopeTabId(scopeKey) === tabId
  )
}

/** The chips begun in a removed workspace, open and closed chats alike. */
export function dropNativeChatPendingAttachmentsOwnedBy(owner: NativeChatComposerDraftOwner): void {
  dropPendingWhere(
    (_scopeKey, pendingOwner) =>
      pendingOwner?.workspaceId === owner.workspaceId &&
      pendingOwner.executionHostId === owner.executionHostId
  )
}

export function clearNativeChatPendingAttachmentsForTests(): void {
  pendingCache.clear()
  pendingOwners.clear()
}
