import { sameNativeChatComposerDraftDocument } from './native-chat-composer-draft-comparison'
import type { NativeChatComposerDraftAddition } from './native-chat-composer-draft-addition'
// Memory owns drafts; storage keeps a copy shared by the API and persistence modules.

import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftImage,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

// Launch seeds also remain in TUI input; only this run can replace them, so their composer copy must not survive reload.
export type DraftRecord = StoredNativeChatComposerDraft & { readonly unsavedText?: string }

/** A write or removal handed to storage and not yet confirmed; `draft` is null for a removal. */
export type UnconfirmedDraftChange = {
  readonly draft: StoredNativeChatComposerDraft | null
  readonly at: number
}

export const records = new Map<string, DraftRecord>()
export type NativeChatDraftPosition = { at: 'start' | 'end'; target?: string; pending: boolean }
export const nativeChatDraftPositions = new WeakMap<
  NativeChatComposerDraft,
  NativeChatDraftPosition
>()

export function retireNativeChatDraftPosition(
  draft: NativeChatComposerDraft | undefined,
  target?: string
): void {
  const position = draft && nativeChatDraftPositions.get(draft)
  if (position && (target === undefined || position.target === target)) {
    position.pending = false
  }
}

/** Publish UI provenance with its exact value; only metadata-only replacements inherit it. */
export function installNativeChatDraftRecord(
  scope: string,
  draft?: DraftRecord,
  position?: NativeChatDraftPosition
): void {
  const previous = records.get(scope)
  if (
    previous &&
    draft &&
    previous.text === draft.text &&
    sameNativeChatComposerDraftDocument(previous.document, draft.document) &&
    !position
  ) {
    position = nativeChatDraftPositions.get(previous)
  } else {
    retireNativeChatDraftPosition(previous)
  }
  if (draft) {
    if (position) {
      nativeChatDraftPositions.set(draft, position)
    }
    records.set(scope, draft)
  } else {
    records.delete(scope)
  }
}

// Changed in memory with no write issued yet; a refused write comes back here for the next flush.
export const dirtyScopes = new Set<string>()
export const unconfirmed = new Map<string, UnconfirmedDraftChange>()
// Drafts whose last write storage refused; shown so the user knows they are held in memory only.
export const refusedScopes = new Set<string>()
export type DraftImageCheck = {
  image: NativeChatComposerDraftImage
  /** The object itself is the current attempt token. */
  attempt?: { authority: string }
}
export const restoredImageChecks = new Map<string, readonly DraftImageCheck[]>()
export const NO_IMAGE_CHECKS: readonly DraftImageCheck[] = []

export function restoredImageKey(image: NativeChatComposerDraftImage): string {
  return JSON.stringify([image.id, image.path, image.connectionId])
}

/** Ordinary edits prune work; restore boundaries register only newly introduced tuples. */
export function reconcileRestoredImageChecks(
  scopeKey: string,
  images: readonly NativeChatComposerDraftImage[],
  previous: readonly NativeChatComposerDraftImage[] = images
): void {
  const current = restoredImageChecks.get(scopeKey) ?? NO_IMAGE_CHECKS
  const held = new Set(
    images
      .filter((image) => image.path && image.unavailableName === undefined)
      .map(restoredImageKey)
  )
  const before = new Set(previous.map(restoredImageKey))
  const next = current.filter((entry) => held.has(restoredImageKey(entry.image)))
  for (const image of images) {
    if (held.has(restoredImageKey(image)) && !before.has(restoredImageKey(image))) {
      next.push({ image })
    }
  }
  if (next.length !== current.length || next.some((entry, index) => entry !== current[index])) {
    if (next.length) {
      restoredImageChecks.set(scopeKey, next)
    } else {
      restoredImageChecks.delete(scopeKey)
    }
  }
}
export const scopeListeners = new Map<string, Set<() => void>>()

/** Pre-hydration appends replay over loaded drafts; ordinary edits replace them. */
export type DraftAppend = (draft: StoredNativeChatComposerDraft) => StoredNativeChatComposerDraft

/** Atomically append in storage, then replay onto hydration if that load could not have read it. */
export type AppendBeforeLoad = {
  /** In-run order, compared with the order at which a load attempt read storage. */
  readonly sequence: number
  readonly append: DraftAppend
  committed: boolean
}

type LoadBookkeeping = {
  hydrated: boolean
  /** Sequence of the last append made before the load landed. */
  appendSequence: number
  readonly editedBeforeLoad: Set<string>
  readonly appendsBeforeLoad: Map<string, AppendBeforeLoad[]>
  readonly deletionsBeforeLoad: ((
    scopeKey: string,
    draft: StoredNativeChatComposerDraft
  ) => boolean)[]
}

export const load: LoadBookkeeping = {
  hydrated: false,
  appendSequence: 0,
  editedBeforeLoad: new Set(),
  appendsBeforeLoad: new Map(),
  deletionsBeforeLoad: []
}

let lastSavedAt = 0

/** Monotonic within a run, so drafts changed in the same millisecond still age in order. */
export function nextSavedAt(): number {
  lastSavedAt = Math.max(Date.now(), lastSavedAt + 1)
  return lastSavedAt
}

export function notifyScope(scopeKey: string): void {
  scopeListeners.get(scopeKey)?.forEach((listener) => listener())
}

/** A local change not yet in storage, which a write from another window must not replace. */
export function hasLocalChange(scopeKey: string): boolean {
  return dirtyScopes.has(scopeKey) || unconfirmed.has(scopeKey)
}

export function clearDraftMemoryForTests(): void {
  for (const draft of records.values()) {
    retireNativeChatDraftPosition(draft)
  }
  records.clear()
  dirtyScopes.clear()
  unconfirmed.clear()
  refusedScopes.clear()
  restoredImageChecks.clear()
  lastSavedAt = 0
  load.hydrated = false
  load.appendSequence = 0
  load.editedBeforeLoad.clear()
  load.appendsBeforeLoad.clear()
  load.deletionsBeforeLoad.length = 0
}

export type NativeChatDraftAppend =
  | NativeChatComposerDraftAddition
  | ((draft: NativeChatComposerDraft) => NativeChatComposerDraft)
const appendListeners = new Map<
  string,
  Set<(addition: NativeChatDraftAppend, previous: NativeChatComposerDraft) => void>
>()
export function subscribeToNativeChatComposerDraftAppend(
  scope: string,
  listener: (addition: NativeChatDraftAppend, previous: NativeChatComposerDraft) => void
): () => void {
  const scoped = appendListeners.get(scope) ?? new Set()
  appendListeners.set(scope, scoped)
  scoped.add(listener)
  return () => {
    scoped.delete(listener)
    if (scoped.size === 0) {
      appendListeners.delete(scope)
    }
  }
}

export function notifyDraftAppend(
  scope: string,
  addition: NativeChatDraftAppend,
  previous: NativeChatComposerDraft
): void {
  appendListeners.get(scope)?.forEach((listener) => listener(addition, previous))
}

export type NativeChatEditDraftDestination = { scopeKey: string; active: boolean }
export const ephemeralDrafts = new Map<string, NativeChatEditDraftDestination>()

export function captureNativeChatEditDraftDestination(
  scopeKey: string
): NativeChatEditDraftDestination | undefined {
  return ephemeralDrafts.get(scopeKey)
}

export function redirectNativeChatEditDraft(scopeKey: string, destination: string): void {
  const target = ephemeralDrafts.get(scopeKey)
  if (target) {
    target.scopeKey = destination
  }
}

export function isNativeChatEditDraft(scopeKey: string): boolean {
  return scopeKey.startsWith('queued-edit:')
}

export function closeNativeChatEditDraft(scopeKey: string): void {
  const target = ephemeralDrafts.get(scopeKey)
  if (target?.scopeKey === scopeKey) {
    target.active = false
  }
  ephemeralDrafts.delete(scopeKey)
  installNativeChatDraftRecord(scopeKey)
  notifyScope(scopeKey)
}
