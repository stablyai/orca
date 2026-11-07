import type { NativeChatDraftReturnSource } from './native-chat-draft-return-products'
import { currentDraftScope, captureLaunchDraftDestination } from './native-chat-launch-draft-source'
export {
  deleteNativeChatComposerDraftsWhere,
  deleteNativeChatComposerDraft,
  deleteNativeChatComposerDraftsForTab,
  deleteNativeChatComposerDraftsOwnedBy
} from './native-chat-composer-draft-removal'
export {
  structuredAgentSessionDraftScopeKey,
  structuredAgentSessionIdOfDraftScope,
  nativeChatDraftScopeTabId
} from './native-chat-composer-draft-scope'
import { nativeChatPastedTextToken } from './native-chat-pasted-text-reference'
// Own complete unsent drafts in memory so each write repairs storage from one authoritative record.

import {
  sameNativeChatComposerDraftDocument,
  sameNativeChatComposerDraftImages
} from './native-chat-composer-draft-comparison'
import {
  placeNativeChatComposerDraftAddition,
  withNativeChatComposerDraftAddition,
  withIndependentNativeChatComposerDraft,
  type NativeChatComposerDraftAddition
} from './native-chat-composer-draft-addition'
import { journalNativeChatComposerDraftAddition } from './native-chat-composer-draft-journal'
import {
  beginNativeChatDraftReturn,
  commitNativeChatDraftReturn,
  type NativeChatDraftReturnProduct
} from './native-chat-draft-return-products'
import {
  clearDraftMemoryForTests,
  resolveNativeChatComposerDraftOwner,
  installNativeChatDraftRecord,
  type NativeChatDraftPosition,
  nativeChatDraftPositions,
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
  isNativeChatMemoryOnlyDraft,
  isNativeChatSetupDraft,
  reconcileRestoredImageChecks,
  type DraftAppend,
  type DraftRecord,
  releaseNativeChatComposerSubmission,
  retainLaunchDraftSource,
  type DraftSubmission
} from './native-chat-composer-draft-memory'
import {
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
  type NativeChatComposerDraftChange,
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

export type { NativeChatComposerDraftChange } from './native-chat-composer-draft-storage'
/** Edit scopes share input machinery but never enter draft persistence. */
export function openNativeChatEditDraft(
  scopeKey: string,
  draft: NativeChatComposerDraft,
  returning?: { destination: string; revoked?: DraftRecord }
): void {
  ephemeralDrafts.set(scopeKey, { scopeKey, active: true, returning })
  updateNativeChatComposerDraft(scopeKey, draft, 'immediate')
}

const EMPTY_DRAFT: DraftRecord = { text: '', images: [], savedAt: 0 }

export function subscribeToNativeChatComposerDraft(
  scopeKey: string,
  listener: () => void
): () => void {
  const destination = captureLaunchDraftDestination(scopeKey)
  scopeKey = currentDraftScope(scopeKey)
  const member = () => listener()
  const listeners = scopeListeners.get(scopeKey) ?? new Set()
  scopeListeners.set(scopeKey, listeners)
  listeners.add(member)
  return () => {
    const current = scopeListeners.get(destination?.scopeKey ?? scopeKey)
    current?.delete(member)
    if (current?.size === 0) {
      scopeListeners.delete(destination?.scopeKey ?? scopeKey)
    }
  }
}

/** A draft storage refused to save: it is kept in memory only until a later write lands. */
export function isNativeChatComposerDraftUnsaved(scopeKey: string): boolean {
  scopeKey = currentDraftScope(scopeKey)
  return !isNativeChatSetupDraft(scopeKey) && refusedScopes.has(scopeKey) && records.has(scopeKey)
}

export function readNativeChatComposerDraft(
  scopeKey: string
): NativeChatComposerDraft & Pick<StoredNativeChatComposerDraft, 'owner'> {
  return records.get(currentDraftScope(scopeKey)) ?? EMPTY_DRAFT
}

export function finishNativeChatComposerSubmission(
  scopeKey: string,
  submission: DraftSubmission,
  recover = false
): void {
  scopeKey = submission.scopeKey
  const draft = releaseNativeChatComposerSubmission(scopeKey, submission)
  if (recover && draft) {
    appendToNativeChatComposerDraft(
      scopeKey,
      draft,
      resolveNativeChatComposerDraftOwner(scopeKey) ?? draft.owner,
      undefined,
      true,
      submission
    )
  }
}

/** Coalesce typing, persist hand-backs/clears immediately, and remove empty drafts so sent input cannot return. */
export function updateNativeChatComposerDraft(
  reference: string,
  change: NativeChatComposerDraftChange,
  persist: 'immediate' | 'deferred',
  append?: DraftAppend,
  position?: NativeChatDraftPosition,
  product?: NativeChatDraftReturnProduct,
  sources?: readonly NativeChatDraftReturnSource[]
): void {
  const scopeKey = currentDraftScope(reference)
  if (isNativeChatEditDraft(scopeKey) && !ephemeralDrafts.has(scopeKey)) {
    return
  }
  product ??= beginNativeChatDraftReturn(sources, scopeKey, records.get(scopeKey))
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
    !position &&
    JSON.stringify(pastedTextFiles) === JSON.stringify(current.pastedTextFiles ?? {}) &&
    text === current.text &&
    sameNativeChatComposerDraftDocument(document, current.document) &&
    unsavedText === current.unsavedText &&
    sameNativeChatComposerDraftImages(images, current.images)
  ) {
    commitNativeChatDraftReturn(product, records.get(scopeKey))
    if (persist === 'immediate' && dirtyScopes.has(scopeKey)) {
      persistNativeChatComposerDraft(scopeKey, 'immediate', undefined, product)
    }
    return
  }
  if (text === '' && images.length === 0) {
    installNativeChatDraftRecord(scopeKey)
    commitNativeChatDraftReturn(product, undefined)
    reconcileRestoredImageChecks(scopeKey, [])
    notifyScope(scopeKey)
    if (!isNativeChatMemoryOnlyDraft(scopeKey)) {
      persistNativeChatComposerDraft(scopeKey, 'immediate', append, product)
    }
    return
  }
  // A setup's first non-empty input creates its session source; other scopes have none.
  retainLaunchDraftSource(reference)
  // Retain original host provenance; removal derives materialized placement from the conversation.
  const owner = current.owner ?? change.owner ?? resolveNativeChatComposerDraftOwner(scopeKey)
  const record: DraftRecord = {
    text,
    ...(Object.keys(pastedTextFiles).length ? { pastedTextFiles } : {}),
    ...(document ? { document } : {}),
    // Why: an unchanged row keeps its identity, so typing does not re-render every image consumer.
    images: sameNativeChatComposerDraftImages(images, current.images)
      ? current.images
      : [...images],
    savedAt: nextSavedAt(),
    ...(owner ? { owner } : {}),
    ...(unsavedText === undefined ? {} : { unsavedText })
  }
  installNativeChatDraftRecord(scopeKey, record, position)
  commitNativeChatDraftReturn(product, record)
  reconcileRestoredImageChecks(scopeKey, record.images)
  notifyScope(scopeKey)
  if (isNativeChatMemoryOnlyDraft(scopeKey)) {
    return
  }
  persistNativeChatComposerDraft(scopeKey, persist, append, product)
  if (!load.hydrated) {
    // Why: a window whose startup never started the load still gets its saved drafts.
    void hydrateNativeChatComposerDrafts()
  }
}

/** Replay additions over late hydration without duplicates; true means durable hand-back, allowing deletion of its source copy. */
export function appendToNativeChatComposerDraft(
  scopeKey: string,
  addition: NativeChatComposerDraftAddition,
  owner?: NativeChatComposerDraftOwner,
  position?: (draft: NativeChatComposerDraft) => NativeChatDraftPosition,
  independent = false,
  source?: NativeChatDraftReturnSource,
  sourceRecord?: DraftRecord,
  sourceScope?: string
): boolean {
  scopeKey = currentDraftScope(scopeKey)
  const before = records.get(scopeKey)
  const product = beginNativeChatDraftReturn(source, scopeKey, before, sourceRecord, sourceScope)
  const current = readNativeChatComposerDraft(scopeKey)
  const placed = placeNativeChatComposerDraftAddition(current, addition)
  const add = independent
    ? withIndependentNativeChatComposerDraft
    : withNativeChatComposerDraftAddition
  const compose = (base: StoredNativeChatComposerDraft) => ({ ...base, ...add(base, placed) })
  const { text, images, document, pastedTextFiles } = compose({ ...current, savedAt: 0 })
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
    (loaded) => {
      const merged = compose(loaded)
      if (position) {
        nativeChatDraftPositions.set(merged, position(merged))
      }
      return merged
    },
    position?.({ text, images, document, pastedTextFiles }),
    product
  )
  if (text !== current.text) {
    notifyDraftAppend(scopeKey, placed, current)
  }
  const after = product ? product.after : records.get(scopeKey)
  if (!after) {
    return true
  }
  // Why: a hand-back the draft already holds changes nothing, but that draft may not be saved yet.
  if (after === before && !hasLocalChange(scopeKey) && !refusedScopes.has(scopeKey)) {
    return true
  }
  return (
    isNativeChatMemoryOnlyDraft(scopeKey) ||
    journalNativeChatComposerDraftAddition(scopeKey, placed, after.savedAt, product)
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

export function clearNativeChatComposerDraftsForTests(): void {
  ephemeralDrafts.clear()
  clearDraftMemoryForTests()
  resetNativeChatComposerDraftPersistenceForTests()
  resetNativeChatComposerDraftLoadForTests()
  setNativeChatComposerDraftStorageForTests(null)
}

export {
  subscribeToNativeChatComposerDraftAppend,
  hasUnsavedNativeChatComposerDraftChange,
  captureNativeChatComposerSubmission,
  setNativeChatComposerDraftOwnerResolver,
  resolveNativeChatComposerDraftOwner,
  captureNativeChatEditDraftDestination,
  redirectNativeChatEditDraft,
  isNativeChatEditDraft,
  nativeChatLaunchPromptDraftScopeKey,
  writeLaunchSetupOptions,
  closeNativeChatEditDraft,
  type NativeChatEditDraftDestination
} from './native-chat-composer-draft-memory'
