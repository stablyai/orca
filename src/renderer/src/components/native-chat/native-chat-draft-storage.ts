// Saved copy of the composer drafts, so a half-typed message survives quitting Orca. Typing is
// saved after a short pause and flushed when the page hides or unloads; a put-back is saved at
// once. A sent message stays saved until the host has it (native-chat-held-sends for structured
// chats, the cache's send hold for terminal ones), so a crash before that restores the unsent text
// and a crash after it cannot bring it back. On
// desktop the main process confirms each write once the file op returned; the web client keeps
// browser storage, which reaches disk on the browser's own delay, so a browser crash can.

import type {
  NativeChatDraftStoreResult,
  PersistedNativeChatDraft,
  SavedNativeChatDraft
} from '../../../../shared/native-chat-draft-record'

export type {
  NativeChatDraftAttachment,
  NativeChatDraftAttachmentLocation,
  NativeChatHeldSend,
  NativeChatTuiInputSeed,
  PersistedNativeChatDraft
} from '../../../../shared/native-chat-draft-record'
export { isEmptyNativeChatDraft } from '../../../../shared/native-chat-draft-record'

/** Whether a write reached disk; a `memory-only` draft is lost when Orca quits. */
export type NativeChatDraftWriteResult = 'persisted' | 'memory-only'

const TYPING_PERSIST_DELAY_MS = 300
// Why bounded: saving is bookkeeping; a stalled disk must never hold the user's action back.
const SAVE_WAIT_BOUND_MS = 250

const pendingDrafts = new Map<string, PersistedNativeChatDraft | null>()
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
const latestWrites = new Map<string, Promise<NativeChatDraftStoreResult>>()
let flushListenersInstalled = false
let preloaded: SavedNativeChatDraft[] | null = null

function draftStore() {
  try {
    return typeof window === 'undefined' ? null : (window.api?.nativeChat?.drafts ?? null)
  } catch {
    return null
  }
}

async function writeToStore(
  scopeKey: string,
  draft: PersistedNativeChatDraft | null
): Promise<NativeChatDraftStoreResult> {
  const store = draftStore()
  if (!store) {
    return 'unavailable'
  }
  try {
    return await store.write(scopeKey, draft)
  } catch {
    return 'failed'
  }
}

function cancelPending(scopeKey: string): void {
  const timer = pendingTimers.get(scopeKey)
  if (timer !== undefined) {
    clearTimeout(timer)
    pendingTimers.delete(scopeKey)
  }
  pendingDrafts.delete(scopeKey)
}

/** Writes now, superseding any delayed write for the scope. `null` removes the saved draft. */
export function persistNativeChatDraftNow(
  scopeKey: string,
  draft: PersistedNativeChatDraft | null
): Promise<NativeChatDraftWriteResult> {
  cancelPending(scopeKey)
  const write = writeToStore(scopeKey, draft)
  latestWrites.set(scopeKey, write)
  void write.then(() => {
    if (latestWrites.get(scopeKey) === write) {
      latestWrites.delete(scopeKey)
    }
  })
  return write.then((outcome) => (outcome === 'persisted' ? 'persisted' : 'memory-only'))
}

/**
 * Settles once the newest write asked for this draft is written, or after a short bound. A queued
 * message taken back into the box waits here before the host's copy is deleted; a failed or
 * slow write is logged, and the delete goes ahead.
 */
export async function awaitNativeChatDraftSaved(scopeKey: string): Promise<void> {
  const write = latestWrites.get(scopeKey)
  if (!write) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    write,
    new Promise<'timed out'>((resolve) => {
      timer = setTimeout(() => resolve('timed out'), SAVE_WAIT_BOUND_MS)
    })
  ])
  clearTimeout(timer)
  if (outcome === 'failed' || outcome === 'timed out') {
    console.warn('[native-chat] draft not saved before going on', { scopeKey, reason: outcome })
  }
}

/** Whether the store saves a send's clear at Enter rather than once the host has the message. */
export function nativeChatDraftStoreSavesSendClearAtOnce(): boolean {
  return draftStore()?.savesSendClearAtOnce === true
}

/** Whether typing for this draft is still waiting for its pause to be saved. */
export function hasPendingNativeChatDraftPersist(scopeKey: string): boolean {
  return pendingDrafts.has(scopeKey)
}

export function flushNativeChatDraftPersists(): void {
  for (const [scopeKey, draft] of Array.from(pendingDrafts)) {
    void persistNativeChatDraftNow(scopeKey, draft)
  }
}

function installFlushListeners(): void {
  if (
    flushListenersInstalled ||
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return
  }
  flushListenersInstalled = true
  window.addEventListener('beforeunload', flushNativeChatDraftPersists)
  window.addEventListener('pagehide', flushNativeChatDraftPersists)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushNativeChatDraftPersists()
    }
  })
}

/** Saves typing after a short pause; the latest draft wins. */
export function scheduleNativeChatDraftPersist(
  scopeKey: string,
  draft: PersistedNativeChatDraft | null
): void {
  installFlushListeners()
  const timer = pendingTimers.get(scopeKey)
  if (timer !== undefined) {
    clearTimeout(timer)
  }
  pendingDrafts.set(scopeKey, draft)
  pendingTimers.set(
    scopeKey,
    setTimeout(
      () => void persistNativeChatDraftNow(scopeKey, pendingDrafts.get(scopeKey) ?? null),
      TYPING_PERSIST_DELAY_MS
    )
  )
}

/** Loads the saved drafts during startup, before any chat mounts. Never fails startup. */
export async function preloadNativeChatDrafts(): Promise<void> {
  const store = draftStore()
  // Why not where other windows write too (web tabs): a snapshot now would miss their changes
  // until a chat first reads drafts, so that read goes to the store instead.
  if (!store || store.onExternalChange) {
    return
  }
  try {
    preloaded = await store.load()
  } catch (error) {
    // The first chat to mount reads them synchronously instead.
    console.warn('[native-chat] could not load saved drafts', error)
  }
}

/** The saved drafts, oldest first; read synchronously if startup did not preload them. */
export function loadPersistedNativeChatDrafts(): SavedNativeChatDraft[] {
  if (!preloaded) {
    try {
      preloaded = draftStore()?.loadSync() ?? []
    } catch {
      preloaded = []
    }
  }
  return preloaded
}

/**
 * Calls back when another window changes a saved draft (a second browser tab of the web client).
 * A key with a write still pending here is skipped: this window's draft is newer.
 */
export function observeOtherWindowNativeChatDrafts(
  onChange: (scopeKey: string, draft: PersistedNativeChatDraft | null) => void
): void {
  draftStore()?.onExternalChange?.((scopeKey, draft) => {
    if (!pendingDrafts.has(scopeKey)) {
      onChange(scopeKey, draft)
    }
  })
}

export function resetNativeChatDraftStorageForTests(): void {
  for (const scopeKey of Array.from(pendingTimers.keys())) {
    cancelPending(scopeKey)
  }
  pendingDrafts.clear()
  latestWrites.clear()
  preloaded = null
}
