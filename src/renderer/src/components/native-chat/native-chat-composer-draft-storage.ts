// The stored form of composer drafts and the storage they live in. Drafts are kept in their own
// store (IndexedDB), not localStorage, so they never compete with other saved state for its quota
// and need no budget: every draft comes back.

import type { JSONContent } from '@tiptap/react'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { createIndexedDbNativeChatComposerDraftStorage } from './native-chat-composer-draft-indexeddb'

export type NativeChatComposerDraftImage = {
  id: string
  /** Empty for an image Orca could not keep. */
  path: string
  connectionId?: string
  /** Set on an image Orca could not keep: the file name the user must attach again. */
  unavailableName?: string
}

export type NativeChatComposerDraft = {
  readonly text: string
  /** The editor's document for exactly `text`; dropped when the text changes without one. */
  readonly document?: JSONContent
  readonly images: readonly NativeChatComposerDraftImage[]
}

/** The workspace whose chat the draft was written in; its removal deletes the draft. */
export type NativeChatComposerDraftOwner = {
  readonly workspaceId: string
  readonly executionHostId: ExecutionHostId
}

export type StoredNativeChatComposerDraft = NativeChatComposerDraft & {
  readonly savedAt: number
  readonly owner?: NativeChatComposerDraftOwner
}

/** Where drafts are kept. Every write and removal settles once storage has committed it, and
 *  rejects when storage refused it. */
export type NativeChatComposerDraftStorage = {
  loadAll(): Promise<ReadonlyMap<string, unknown>>
  read(scopeKey: string): Promise<unknown>
  write(scopeKey: string, draft: StoredNativeChatComposerDraft): Promise<void>
  remove(scopeKeys: readonly string[]): Promise<void>
  /** Reads the stored record and writes what `apply` makes of it, as one change. */
  update(
    scopeKey: string,
    apply: (stored: unknown) => StoredNativeChatComposerDraft | null
  ): Promise<void>
}

/** Drafts kept for this run only: the storage of an environment without IndexedDB (unit tests),
 *  and the fake those tests drive. */
export function createMemoryNativeChatComposerDraftStorage(): NativeChatComposerDraftStorage & {
  readonly drafts: Map<string, StoredNativeChatComposerDraft>
  refuseWrites: boolean
} {
  const drafts = new Map<string, StoredNativeChatComposerDraft>()
  const storage = {
    drafts,
    refuseWrites: false,
    loadAll: async () => new Map(drafts),
    read: async (scopeKey: string) => drafts.get(scopeKey),
    write: (scopeKey: string, draft: StoredNativeChatComposerDraft) => {
      if (storage.refuseWrites) {
        return Promise.reject(new DOMException('refused', 'QuotaExceededError'))
      }
      drafts.set(scopeKey, draft)
      return Promise.resolve()
    },
    remove: (scopeKeys: readonly string[]) => {
      for (const scopeKey of scopeKeys) {
        drafts.delete(scopeKey)
      }
      return Promise.resolve()
    },
    update: (
      scopeKey: string,
      apply: (stored: unknown) => StoredNativeChatComposerDraft | null
    ) => {
      if (storage.refuseWrites) {
        return Promise.reject(new DOMException('refused', 'QuotaExceededError'))
      }
      const next = apply(drafts.get(scopeKey))
      if (next) {
        drafts.set(scopeKey, next)
      } else {
        drafts.delete(scopeKey)
      }
      return Promise.resolve()
    }
  }
  return storage
}

let storage: NativeChatComposerDraftStorage | null = null

export function nativeChatComposerDraftStorage(): NativeChatComposerDraftStorage {
  storage ??=
    typeof indexedDB === 'undefined'
      ? createMemoryNativeChatComposerDraftStorage()
      : createIndexedDbNativeChatComposerDraftStorage(indexedDB)
  return storage
}

export function setNativeChatComposerDraftStorageForTests(
  next: NativeChatComposerDraftStorage | null
): void {
  storage = next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only the editor's own root node is restored; anything else falls back to the plain text. */
function isEditorDocument(value: unknown): value is JSONContent {
  return isRecord(value) && value.type === 'doc'
}

function parseImage(value: unknown): NativeChatComposerDraftImage | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, path, connectionId, unavailableName } = value
  if (typeof id !== 'string') {
    return null
  }
  if (typeof unavailableName === 'string') {
    return { id, path: '', unavailableName }
  }
  if (typeof path !== 'string' || path === '') {
    return null
  }
  return { id, path, ...(typeof connectionId === 'string' ? { connectionId } : {}) }
}

function parseOwner(value: unknown): NativeChatComposerDraftOwner | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const { workspaceId, executionHostId } = value
  const host = typeof executionHostId === 'string' ? parseExecutionHostId(executionHostId) : null
  return typeof workspaceId === 'string' && host
    ? { workspaceId, executionHostId: host.id }
    : undefined
}

/** A stored value as a draft, or null when it isn't one (a newer or damaged record). */
export function parseStoredNativeChatComposerDraft(
  value: unknown
): StoredNativeChatComposerDraft | null {
  if (!isRecord(value)) {
    return null
  }
  const { text, document, images, savedAt } = value
  if (typeof text !== 'string' || typeof savedAt !== 'number' || !Array.isArray(images)) {
    return null
  }
  const owner = parseOwner(value.owner)
  return {
    text,
    ...(isEditorDocument(document) ? { document } : {}),
    images: images.flatMap((image) => parseImage(image) ?? []),
    savedAt,
    ...(owner ? { owner } : {})
  }
}

const LEGACY_LOCAL_STORAGE_PREFIX = 'orca:nativeChatComposerDraft:v1:'

/** Drafts this change kept in localStorage before it moved them; never released, so they go. */
export function removeLegacyLocalStorageNativeChatComposerDrafts(): void {
  try {
    const keys: string[] = []
    for (let position = 0; position < localStorage.length; position += 1) {
      const key = localStorage.key(position)
      if (key?.startsWith(LEGACY_LOCAL_STORAGE_PREFIX)) {
        keys.push(key)
      }
    }
    for (const key of keys) {
      localStorage.removeItem(key)
    }
  } catch {
    // No localStorage: nothing was kept there either.
  }
}
