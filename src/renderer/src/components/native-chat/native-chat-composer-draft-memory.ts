// The draft store's memory, shared by its API (the store module) and its persistence. Memory is
// the owner of every draft; storage only keeps a copy of it.

import type {
  NativeChatComposerDraftImage,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

// Why unsavedText: an adopted launch seed is also parked in the agent's input line, and only this
// run's seed knows to replace it, so a reload must not bring the copy back.
export type DraftRecord = StoredNativeChatComposerDraft & { readonly unsavedText?: string }

/** A write or removal handed to storage and not yet confirmed; `draft` is null for a removal. */
export type UnconfirmedDraftChange = {
  readonly draft: StoredNativeChatComposerDraft | null
  readonly at: number
}

export const records = new Map<string, DraftRecord>()
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

/** How a change before the startup load lands meets the loaded draft: an edit replaces it, an
 *  append (text or images given back, a paste) is applied again on top of it. */
export type DraftAppend = (draft: StoredNativeChatComposerDraft) => StoredNativeChatComposerDraft

/** An append made before the load landed: written onto the stored draft in one change, and made
 *  again on the loaded draft when that load could not have read it. */
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

// The startup load's bookkeeping, emptied once it lands.
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
