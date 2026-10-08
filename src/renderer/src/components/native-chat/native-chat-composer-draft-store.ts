// The one owner of each composer scope's unsent message: its text, the editor document for that
// text and its settled image refs. Every writer changes the whole record here in memory, and
// storage is written from that record, so a reload or quit gives the draft back and a failed or
// skipped write is repaired by the next one.

import type { JSONContent } from '@tiptap/react'
import {
  sameNativeChatComposerDraftDocument,
  sameNativeChatComposerDraftImages
} from './native-chat-composer-draft-comparison'
import {
  withNativeChatComposerDraftAddition,
  type NativeChatComposerDraftAddition
} from './native-chat-composer-draft-addition'
import { journalNativeChatComposerDraftAddition } from './native-chat-composer-draft-journal'
import {
  clearDraftMemoryForTests,
  dirtyScopes,
  hasLocalChange,
  load,
  nextSavedAt,
  notifyScope,
  records,
  refusedScopes,
  scopeListeners,
  unverifiedScopes,
  type DraftAppend,
  type DraftRecord
} from './native-chat-composer-draft-memory'
import {
  deleteLoadingNativeChatComposerDraftsWhere,
  persistNativeChatComposerDraft,
  resetNativeChatComposerDraftPersistenceForTests
} from './native-chat-composer-draft-persistence'
import {
  hydrateNativeChatComposerDrafts,
  resetNativeChatComposerDraftLoadForTests
} from './native-chat-composer-draft-load'
import {
  setNativeChatComposerDraftStorageForTests,
  type NativeChatComposerDraft,
  type NativeChatComposerDraftImage,
  type NativeChatComposerDraftOwner,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

export {
  flushNativeChatComposerDrafts,
  isKeptLocalPaste,
  nativeChatComposerDraftWriteSettled,
  nativeChatComposerDraftWritesSettled,
  unavailableNativeChatComposerDraftImage
} from './native-chat-composer-draft-persistence'
export {
  hydrateNativeChatComposerDrafts,
  isNativeChatComposerDraftLoadPending,
  waitForNativeChatComposerDrafts
} from './native-chat-composer-draft-load'

/** This window has changed the draft and storage has not confirmed it yet. */
export function hasUnsavedNativeChatComposerDraftChange(scopeKey: string): boolean {
  return hasLocalChange(scopeKey)
}

export type NativeChatComposerDraftChange = {
  text?: string
  /** Present, even as undefined, to replace the document. */
  document?: JSONContent
  images?: readonly NativeChatComposerDraftImage[]
  /** Text shown but never saved while the draft still holds exactly it. */
  unsavedText?: string
  /** A new draft's owner when its chat may no longer be open to name it: the one it was begun in. */
  owner?: NativeChatComposerDraftOwner
}

const EMPTY_DRAFT: DraftRecord = { text: '', images: [], savedAt: 0 }

let resolveOwner: ((scopeKey: string) => NativeChatComposerDraftOwner | undefined) | null = null

/** Names the workspace a scope's chat belongs to, so a new draft can record its owner. */
export function setNativeChatComposerDraftOwnerResolver(
  resolver: (scopeKey: string) => NativeChatComposerDraftOwner | undefined
): void {
  resolveOwner = resolver
}

/** The owner a new draft in this scope would record now. */
export function resolveNativeChatComposerDraftOwner(
  scopeKey: string
): NativeChatComposerDraftOwner | undefined {
  return resolveOwner?.(scopeKey)
}

/** Composers render from the store; this tells one that its pane's draft changed. */
export function subscribeToNativeChatComposerDraft(
  scopeKey: string,
  listener: () => void
): () => void {
  const listeners = scopeListeners.get(scopeKey) ?? new Set()
  scopeListeners.set(scopeKey, listeners)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && scopeListeners.get(scopeKey) === listeners) {
      scopeListeners.delete(scopeKey)
    }
  }
}

/** A draft read back from storage this run whose image files have not been checked yet. */
export function isNativeChatComposerDraftUnverified(scopeKey: string): boolean {
  return unverifiedScopes.has(scopeKey)
}

export function markNativeChatComposerDraftVerified(scopeKey: string): void {
  if (unverifiedScopes.delete(scopeKey)) {
    notifyScope(scopeKey)
  }
}

/** A draft storage refused to save: it is kept in memory only until a later write lands. */
export function isNativeChatComposerDraftUnsaved(scopeKey: string): boolean {
  return refusedScopes.has(scopeKey) && records.has(scopeKey)
}

function isEmptyDraft(draft: NativeChatComposerDraft): boolean {
  return draft.text === '' && draft.images.length === 0
}

export function readNativeChatComposerDraft(scopeKey: string): NativeChatComposerDraft {
  return records.get(scopeKey) ?? EMPTY_DRAFT
}

/**
 * Changes fields of the scope's draft. `deferred` is for typing, coalesced into one write;
 * `immediate` saves now: text or images given back from a copy about to be deleted, and clears.
 * An emptied draft is removed at once, so a sent message never comes back.
 */
export function updateNativeChatComposerDraft(
  scopeKey: string,
  change: NativeChatComposerDraftChange,
  persist: 'immediate' | 'deferred',
  append?: DraftAppend
): void {
  const current = records.get(scopeKey) ?? EMPTY_DRAFT
  const text = change.text ?? current.text
  const document = 'document' in change ? change.document : current.document
  const images = change.images ?? current.images
  const unsavedText = change.unsavedText ?? current.unsavedText
  if (
    text === current.text &&
    sameNativeChatComposerDraftDocument(document, current.document) &&
    unsavedText === current.unsavedText &&
    sameNativeChatComposerDraftImages(images, current.images)
  ) {
    if (persist === 'immediate' && dirtyScopes.has(scopeKey)) {
      persistNativeChatComposerDraft(scopeKey, 'immediate')
    }
    return
  }
  if (isEmptyDraft({ text, images })) {
    records.delete(scopeKey)
    notifyScope(scopeKey)
    persistNativeChatComposerDraft(scopeKey, 'immediate', append)
    return
  }
  // Why stamped once: a conversation never moves to another workspace, so its owner stays true.
  const owner = current.owner ?? change.owner ?? resolveOwner?.(scopeKey)
  const record: DraftRecord = {
    text,
    ...(document ? { document } : {}),
    images: [...images],
    savedAt: nextSavedAt(),
    ...(owner ? { owner } : {}),
    ...(unsavedText === undefined ? {} : { unsavedText })
  }
  records.set(scopeKey, record)
  notifyScope(scopeKey)
  persistNativeChatComposerDraft(scopeKey, persist, append)
  if (!load.hydrated) {
    // Why: a window whose startup never started the load still gets its saved drafts.
    void hydrateNativeChatComposerDrafts()
  }
}

function withAddition<T extends NativeChatComposerDraft>(
  draft: T,
  addition: NativeChatComposerDraftAddition,
  options: { once?: boolean } = {}
): T {
  const next = withNativeChatComposerDraftAddition(draft, addition, options)
  return { ...draft, ...next, ...(next.text === draft.text ? {} : { document: undefined }) }
}

/**
 * Adds to the scope's draft as it is now: text or images given back, or attached. Before the
 * startup load lands, the same addition is made again to the loaded draft, so nothing saved
 * earlier is replaced by it, unless that draft already holds it (a hand-back repeated after a
 * crash before its copy was deleted). True once the addition is durable: storage commits later,
 * so it is also journaled at once, and the copy it came from may then be deleted.
 */
export function appendToNativeChatComposerDraft(
  scopeKey: string,
  addition: NativeChatComposerDraftAddition,
  owner?: NativeChatComposerDraftOwner
): boolean {
  const before = records.get(scopeKey)
  const current = readNativeChatComposerDraft(scopeKey)
  const { text, images } = withAddition(current, addition)
  updateNativeChatComposerDraft(
    scopeKey,
    {
      text,
      images,
      ...(text === current.text ? {} : { document: undefined }),
      ...(owner ? { owner } : {})
    },
    'immediate',
    (loaded) => withAddition(loaded, addition, { once: true })
  )
  const after = records.get(scopeKey)
  if (!after) {
    return true
  }
  // Why: a hand-back the draft already holds changes nothing, but that draft may not be saved yet.
  if (after === before && !hasLocalChange(scopeKey) && !refusedScopes.has(scopeKey)) {
    return true
  }
  return journalNativeChatComposerDraftAddition(scopeKey, addition, after.savedAt)
}

/**
 * Clears a sent draft only while it is still what was sent, so a send settling late never wipes
 * what was typed or attached since, even from a composer that was replaced meanwhile.
 */
export function clearNativeChatComposerDraftIfUnchanged(
  scopeKey: string,
  sent: NativeChatComposerDraft
): boolean {
  const current = readNativeChatComposerDraft(scopeKey)
  if (
    current.text !== sent.text ||
    !sameNativeChatComposerDraftImages(current.images, sent.images)
  ) {
    return false
  }
  updateNativeChatComposerDraft(scopeKey, { text: '', images: [] }, 'immediate')
  return true
}

const STRUCTURED_AGENT_SESSION_DRAFT_SCOPE_PREFIX = 'agent-session:'

/** A structured chat's draft belongs to its conversation, so it outlives the tab showing it. */
export function structuredAgentSessionDraftScopeKey(sessionId: string): string {
  return `${STRUCTURED_AGENT_SESSION_DRAFT_SCOPE_PREFIX}${sessionId}`
}

function deleteDraftsWhere(
  matches: (scopeKey: string, draft: StoredNativeChatComposerDraft | undefined) => boolean
): void {
  deleteLoadingNativeChatComposerDraftsWhere(matches)
  for (const scopeKey of new Set([...records.keys(), ...scopeListeners.keys()])) {
    const draft = records.get(scopeKey)
    if (matches(scopeKey, draft)) {
      records.delete(scopeKey)
      notifyScope(scopeKey)
      if (draft) {
        persistNativeChatComposerDraft(scopeKey, 'immediate')
      }
    }
  }
}

/** Drops one scope's draft, for an owner that is gone for good. */
export function deleteNativeChatComposerDraft(scopeKey: string): void {
  deleteDraftsWhere((key) => key === scopeKey)
}

/** The conversation a structured chat's draft belongs to, or null for a pane's draft. */
export function structuredAgentSessionIdOfDraftScope(scopeKey: string): string | null {
  return scopeKey.startsWith(STRUCTURED_AGENT_SESSION_DRAFT_SCOPE_PREFIX)
    ? scopeKey.slice(STRUCTURED_AGENT_SESSION_DRAFT_SCOPE_PREFIX.length)
    : null
}

/** A pane key is `<tabId>:<leaf>`; the leaf is a UUID, while a tab id may hold ':' itself. */
export function nativeChatDraftScopeTabId(scopeKey: string): string {
  return scopeKey.slice(0, scopeKey.lastIndexOf(':'))
}

/** Drops the drafts of every pane in a tab the user closed; its pane keys never come back. A
 *  conversation's draft is never a tab's. */
export function deleteNativeChatComposerDraftsForTab(tabId: string): void {
  deleteDraftsWhere(
    (scopeKey) =>
      !scopeKey.startsWith(STRUCTURED_AGENT_SESSION_DRAFT_SCOPE_PREFIX) &&
      nativeChatDraftScopeTabId(scopeKey) === tabId
  )
}

/** Drops every draft written in a workspace the user removed, open and closed chats alike. */
export function deleteNativeChatComposerDraftsOwnedBy(owner: NativeChatComposerDraftOwner): void {
  deleteDraftsWhere(
    (_scopeKey, draft) =>
      draft?.owner?.workspaceId === owner.workspaceId &&
      draft.owner.executionHostId === owner.executionHostId
  )
}

export function clearNativeChatComposerDraftsForTests(): void {
  clearDraftMemoryForTests()
  resetNativeChatComposerDraftPersistenceForTests()
  resetNativeChatComposerDraftLoadForTests()
  setNativeChatComposerDraftStorageForTests(null)
  resolveOwner = null
}
