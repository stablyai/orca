import type {
  NativeChatComposerDraft,
  StoredNativeChatComposerDraft,
  NativeChatComposerDraftChange,
  NativeChatComposerDraftOwner
} from './native-chat-composer-draft-storage'
import {
  ephemeralDrafts,
  scopeListeners,
  isNativeChatSetupDraft,
  refusedScopes,
  records,
  releaseNativeChatComposerSubmission,
  resolveNativeChatComposerDraftOwner,
  isNativeChatEditDraft,
  dirtyScopes,
  installNativeChatDraftRecord,
  reconcileRestoredImageChecks,
  notifyScope,
  isNativeChatMemoryOnlyDraft,
  nextSavedAt,
  load,
  nativeChatDraftPositions,
  notifyDraftAppend,
  hasLocalChange,
  type DraftRecord,
  type DraftSubmission,
  type NativeChatDraftPosition
} from './native-chat-composer-draft-memory'

import {
  captureLaunchDraftDestination,
  currentDraftScope,
  retainLaunchDraftSource
} from './native-chat-launch-draft-source'

import { nativeChatPastedTextToken } from '../paste/native-chat-pasted-text-reference'
import {
  sameNativeChatComposerDraftDocument,
  sameNativeChatComposerDraftImages
} from './native-chat-composer-draft-comparison'
import { persistNativeChatComposerDraft } from './native-chat-composer-draft-persistence'
import {
  type DraftAppend,
  hydrateNativeChatComposerDrafts
} from './native-chat-composer-draft-load'

import {
  type NativeChatComposerDraftAddition,
  placeNativeChatComposerDraftAddition,
  withIndependentNativeChatComposerDraft,
  withNativeChatComposerDraftAddition
} from './native-chat-composer-draft-addition'
import { journalNativeChatComposerDraftAddition } from './native-chat-composer-draft-journal'
import { isLoneStructuredAgentSessionConversationCommand } from '../../../../../shared/agent-session/view/structured-agent-session-composer'

/** Edit scopes share input machinery but never enter draft persistence. */
export function openNativeChatEditDraft(scopeKey: string, draft: NativeChatComposerDraft): void {
  ephemeralDrafts.set(scopeKey, { scopeKey, active: true })
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
      true
    )
  }
}

/** Coalesce typing, persist hand-backs/clears immediately, and remove empty drafts so sent input cannot return. */
export function updateNativeChatComposerDraft(
  reference: string,
  change: NativeChatComposerDraftChange,
  persist: 'immediate' | 'deferred',
  append?: DraftAppend,
  position?: NativeChatDraftPosition
): void {
  const scopeKey = currentDraftScope(reference)
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
    !position &&
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
  if (text === '' && images.length === 0) {
    installNativeChatDraftRecord(scopeKey)
    reconcileRestoredImageChecks(scopeKey, [])
    notifyScope(scopeKey)
    if (!isNativeChatMemoryOnlyDraft(scopeKey)) {
      persistNativeChatComposerDraft(scopeKey, 'immediate', append)
    }
    return
  }
  // A setup's first non-empty input creates its session source; other scopes have none.
  retainLaunchDraftSource(reference)
  // Why stamped once: a conversation never moves to another workspace, so its owner stays true.
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
  reconcileRestoredImageChecks(scopeKey, record.images)
  notifyScope(scopeKey)
  if (isNativeChatMemoryOnlyDraft(scopeKey)) {
    return
  }
  persistNativeChatComposerDraft(scopeKey, persist, append)
  if (!load.hydrated) {
    // Why: a window whose startup never started the load still gets its saved drafts.
    void hydrateNativeChatComposerDrafts()
  }
}

/**
 * A still-pending placement survives an append that keeps the old text as its prefix: it stays where it
 * was, within the old text (an end placement becomes a caret at the old text's end). An append that
 * replaced the text, or a placement already applied or given up, carries nothing.
 */
function carriedNativeChatDraftPosition(
  before: DraftRecord | undefined,
  text: string
): NativeChatDraftPosition | undefined {
  const previous = before && nativeChatDraftPositions.get(before)
  const kept = before?.text.trimEnd() ?? ''
  if (
    !previous?.pending ||
    text === before?.text ||
    kept === '' ||
    isLoneStructuredAgentSessionConversationCommand(kept) ||
    !text.startsWith(`${kept}\n\n`)
  ) {
    return undefined
  }
  const within = (at: number): number => Math.min(Math.max(at, 0), kept.length)
  const { target } = previous
  const carried =
    previous.at === 'selection'
      ? { at: 'selection' as const, from: within(previous.from), to: within(previous.to) }
      : previous.at === 'end'
        ? { at: 'selection' as const, from: kept.length, to: kept.length }
        : { at: previous.at }
  return { ...carried, ...(target === undefined ? {} : { target }), pending: true }
}

/** Replay additions over late hydration without duplicates; true means durable hand-back, allowing deletion of its source copy. */
export function appendToNativeChatComposerDraft(
  scopeKey: string,
  addition: NativeChatComposerDraftAddition,
  owner?: NativeChatComposerDraftOwner,
  position?: (draft: NativeChatComposerDraft) => NativeChatDraftPosition,
  independent = false
): boolean {
  scopeKey = currentDraftScope(scopeKey)
  const before = records.get(scopeKey)
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
    position?.({ text, images, document, pastedTextFiles }) ??
      carriedNativeChatDraftPosition(before, text)
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
    isNativeChatMemoryOnlyDraft(scopeKey) ||
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
