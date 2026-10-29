import { nativeChatPastedTextToken } from './native-chat-pasted-text-reference'
// Own complete unsent drafts in memory so each write repairs storage from one authoritative record.

import type { JSONContent } from '@tiptap/react'
import {
  sameNativeChatComposerDraftDocument,
  sameNativeChatComposerDraftImages
} from './native-chat-composer-draft-comparison'
import {
  placeNativeChatComposerDraftAddition,
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
  notifyDraftAppend,
  ephemeralDrafts,
  isNativeChatEditDraft,
  reconcileRestoredImageChecks,
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
  waitForNativeChatComposerDrafts
} from './native-chat-composer-draft-load'

export function hasUnsavedNativeChatComposerDraftChange(scopeKey: string): boolean {
  return hasLocalChange(scopeKey)
}

export type NativeChatComposerDraftChange = {
  text?: string
  pastedTextFiles?: Readonly<Record<string, string>>
  /** Present, even as undefined, to replace the document. */
  document?: JSONContent
  images?: readonly NativeChatComposerDraftImage[]
  /** Text shown but never saved while the draft still holds exactly it. */
  unsavedText?: string
  /** A new draft's owner when its chat may no longer be open to name it: the one it was begun in. */
  owner?: NativeChatComposerDraftOwner
}

/** Edit scopes share input machinery but never enter draft persistence. */
export function openNativeChatEditDraft(scopeKey: string, draft: NativeChatComposerDraft): void {
  ephemeralDrafts.set(scopeKey, { scopeKey, active: true })
  updateNativeChatComposerDraft(scopeKey, draft, 'immediate')
}

const EMPTY_DRAFT: DraftRecord = { text: '', images: [], savedAt: 0 }

let resolveOwner: ((scopeKey: string) => NativeChatComposerDraftOwner | undefined) | null = null

/** Names the workspace a scope's chat belongs to, so a new draft can record its owner. */
export function setNativeChatComposerDraftOwnerResolver(
  resolver: (scopeKey: string) => NativeChatComposerDraftOwner | undefined
): void {
  resolveOwner = resolver
}

export function resolveNativeChatComposerDraftOwner(
  scopeKey: string
): NativeChatComposerDraftOwner | undefined {
  return resolveOwner?.(scopeKey)
}

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

/** A draft storage refused to save: it is kept in memory only until a later write lands. */
export function isNativeChatComposerDraftUnsaved(scopeKey: string): boolean {
  return refusedScopes.has(scopeKey) && records.has(scopeKey)
}

function isEmptyDraft(draft: NativeChatComposerDraft): boolean {
  return draft.text === '' && draft.images.length === 0
}

export function readNativeChatComposerDraft(
  scopeKey: string
): NativeChatComposerDraft & Pick<StoredNativeChatComposerDraft, 'owner'> {
  return records.get(scopeKey) ?? EMPTY_DRAFT
}

/** Coalesce typing, persist hand-backs/clears immediately, and remove empty drafts so sent input cannot return. */
export function updateNativeChatComposerDraft(
  scopeKey: string,
  change: NativeChatComposerDraftChange,
  persist: 'immediate' | 'deferred',
  append?: DraftAppend
): void {
  if (isNativeChatEditDraft(scopeKey) && !ephemeralDrafts.has(scopeKey)) {
    return
  }
  const current = records.get(scopeKey) ?? EMPTY_DRAFT
  const text = change.text ?? current.text
  const document = 'document' in change ? change.document : current.document
  const pastedTextFiles = Object.fromEntries(
    Object.entries(change.pastedTextFiles ?? current.pastedTextFiles ?? {}).filter(([id]) =>
      text.includes(nativeChatPastedTextToken(id))
    )
  )
  const images = change.images ?? current.images
  const unsavedText = change.unsavedText ?? current.unsavedText
  if (
    JSON.stringify(pastedTextFiles) === JSON.stringify(current.pastedTextFiles ?? {}) &&
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
    reconcileRestoredImageChecks(scopeKey, [])
    notifyScope(scopeKey)
    if (!isNativeChatEditDraft(scopeKey)) {
      persistNativeChatComposerDraft(scopeKey, 'immediate', append)
    }
    return
  }
  // Why stamped once: a conversation never moves to another workspace, so its owner stays true.
  const owner = current.owner ?? change.owner ?? resolveOwner?.(scopeKey)
  const record: DraftRecord = {
    text,
    ...(Object.keys(pastedTextFiles).length ? { pastedTextFiles } : {}),
    ...(document ? { document } : {}),
    images: [...images],
    savedAt: nextSavedAt(),
    ...(owner ? { owner } : {}),
    ...(unsavedText === undefined ? {} : { unsavedText })
  }
  records.set(scopeKey, record)
  reconcileRestoredImageChecks(scopeKey, record.images)
  notifyScope(scopeKey)
  if (isNativeChatEditDraft(scopeKey)) {
    return
  }
  persistNativeChatComposerDraft(scopeKey, persist, append)
  if (!load.hydrated) {
    // Why: a window whose startup never started the load still gets its saved drafts.
    void hydrateNativeChatComposerDrafts()
  }
}

function withAddition<T extends NativeChatComposerDraft>(
  draft: T,
  addition: NativeChatComposerDraftAddition
): T {
  return { ...draft, ...withNativeChatComposerDraftAddition(draft, addition) }
}

/** Replay additions over late hydration without duplicates; true means durable hand-back, allowing deletion of its source copy. */
export function appendToNativeChatComposerDraft(
  scopeKey: string,
  addition: NativeChatComposerDraftAddition,
  owner?: NativeChatComposerDraftOwner
): boolean {
  const before = records.get(scopeKey)
  const current = readNativeChatComposerDraft(scopeKey)
  const placed = placeNativeChatComposerDraftAddition(current, addition)
  const { text, images, document, pastedTextFiles } = withAddition(current, placed)
  updateNativeChatComposerDraft(
    scopeKey,
    {
      text,
      images,
      document,
      pastedTextFiles,
      ...(owner ? { owner } : {})
    },
    'immediate',
    (loaded) => withAddition(loaded, placed)
  )
  if (text !== current.text) {
    notifyDraftAppend(scopeKey, placed, current)
  }
  const after = records.get(scopeKey)
  if (!after) {
    return true
  }
  // Why: a hand-back the draft already holds changes nothing, but that draft may not be saved yet.
  if (after === before && !hasLocalChange(scopeKey) && !refusedScopes.has(scopeKey)) {
    return true
  }
  return (
    isNativeChatEditDraft(scopeKey) ||
    journalNativeChatComposerDraftAddition(scopeKey, placed, after.savedAt)
  )
}

/** Clear only the sent draft’s unchanged portion so late acceptance cannot erase newer typing or attachments. */
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
      reconcileRestoredImageChecks(scopeKey, [])
      notifyScope(scopeKey)
      if (draft) {
        persistNativeChatComposerDraft(scopeKey, 'immediate')
      }
    }
  }
}

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

/** Delete closed-tab pane drafts; conversation-scoped drafts outlive their tabs. */
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
  ephemeralDrafts.clear()
  clearDraftMemoryForTests()
  resetNativeChatComposerDraftPersistenceForTests()
  resetNativeChatComposerDraftLoadForTests()
  setNativeChatComposerDraftStorageForTests(null)
  resolveOwner = null
}

export { subscribeToNativeChatComposerDraftAppend } from './native-chat-composer-draft-memory'

export {
  captureNativeChatEditDraftDestination,
  redirectNativeChatEditDraft,
  isNativeChatEditDraft,
  closeNativeChatEditDraft,
  type NativeChatEditDraftDestination
} from './native-chat-composer-draft-memory'
