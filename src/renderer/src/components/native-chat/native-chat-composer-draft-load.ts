// Loads every saved draft into memory once at startup, with the journal's unconfirmed changes
// replayed on top. A change made before the load lands is kept: an edit wins over the loaded
// draft, and an append is applied again on top of it.

import {
  dirtyScopes,
  load,
  nextSavedAt,
  notifyScope,
  records,
  unverifiedScopes
} from './native-chat-composer-draft-memory'
import {
  flushNativeChatComposerDrafts,
  installNativeChatComposerDraftBroadcast
} from './native-chat-composer-draft-persistence'
import {
  replayNativeChatComposerDraftJournal,
  snapshotNativeChatComposerDraftJournal,
  type NativeChatComposerDraftJournalSnapshot
} from './native-chat-composer-draft-journal'
import {
  nativeChatComposerDraftStorage,
  parseStoredNativeChatComposerDraft,
  removeLegacyLocalStorageNativeChatComposerDrafts,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

// Why bounded: a database that will not open must not be retried for the whole run; after the
// last try the drafts stay in memory and a refused save shows as one.
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000]

let hydration: Promise<void> | null = null
let started = false
let failedLoads = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

/** The appends this load could not have read: made after it began reading, or never written. */
function withAppends(
  scopeKey: string,
  loaded: StoredNativeChatComposerDraft,
  readAtSequence: number
): DraftLoadResult {
  const missing = (load.appendsBeforeLoad.get(scopeKey) ?? []).filter(
    (entry) => !entry.committed || entry.sequence > readAtSequence
  )
  if (missing.length === 0) {
    return { draft: loaded, changed: false }
  }
  const merged = missing.reduce((draft, entry) => entry.append(draft), loaded)
  return { draft: { ...merged, savedAt: nextSavedAt() }, changed: true }
}

type DraftLoadResult = { draft: StoredNativeChatComposerDraft; changed: boolean }

function applyLoaded(
  loaded: ReadonlyMap<string, unknown>,
  readAtSequence: number,
  journal: NativeChatComposerDraftJournalSnapshot
): void {
  const drafts = new Map<string, StoredNativeChatComposerDraft | null>()
  for (const [scopeKey, value] of loaded) {
    drafts.set(scopeKey, parseStoredNativeChatComposerDraft(value))
  }
  for (const scopeKey of replayNativeChatComposerDraftJournal(drafts, journal)) {
    dirtyScopes.add(scopeKey)
  }
  for (const [scopeKey, appends] of load.appendsBeforeLoad) {
    // Appended with nothing saved before: an empty draft is what the load would have read.
    if (!drafts.has(scopeKey) && appends.some((entry) => !entry.committed)) {
      drafts.set(scopeKey, { text: '', images: [], savedAt: 0 })
    }
  }
  for (const [scopeKey, stored] of drafts) {
    if (load.editedBeforeLoad.has(scopeKey)) {
      continue
    }
    if (!stored || load.deletionsBeforeLoad.some((matches) => matches(scopeKey, stored))) {
      // An unreadable record, a journaled removal, or one deleted here while loading.
      dirtyScopes.add(scopeKey)
      continue
    }
    const { draft, changed } = withAppends(scopeKey, stored, readAtSequence)
    records.set(scopeKey, draft)
    unverifiedScopes.add(scopeKey)
    if (changed) {
      dirtyScopes.add(scopeKey)
    }
    notifyScope(scopeKey)
  }
  load.hydrated = true
  load.editedBeforeLoad.clear()
  load.appendsBeforeLoad.clear()
  load.deletionsBeforeLoad.length = 0
  flushNativeChatComposerDrafts()
}

function retryLater(error: unknown): void {
  if (failedLoads === 0) {
    console.warn('[native-chat-drafts] saved drafts could not be loaded', error)
  }
  const delay = RETRY_DELAYS_MS[failedLoads]
  failedLoads += 1
  if (delay === undefined) {
    // Given up: what was changed meanwhile is all there is, so nothing waits on a load any more.
    load.hydrated = true
    load.editedBeforeLoad.clear()
    load.appendsBeforeLoad.clear()
    load.deletionsBeforeLoad.length = 0
    return
  }
  retryTimer = setTimeout(() => {
    retryTimer = null
    hydration = null
    void hydrateNativeChatComposerDrafts()
  }, delay)
}

/** Loads every saved draft into memory, once; a failed load is retried a few times, then left. */
export function hydrateNativeChatComposerDrafts(): Promise<void> {
  started = true
  hydration ??= (async () => {
    removeLegacyLocalStorageNativeChatComposerDrafts()
    installNativeChatComposerDraftBroadcast()
    // Why read here: storage applies changes in order, so this load reads every append made so far.
    const readAtSequence = load.appendSequence
    const journal = snapshotNativeChatComposerDraftJournal()
    applyLoaded(await nativeChatComposerDraftStorage().loadAll(), readAtSequence, journal)
  })().catch(retryLater)
  return hydration
}

/** Startup waits this long at most; a load still running fills its drafts in when it lands. */
export async function waitForNativeChatComposerDrafts(timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    hydrateNativeChatComposerDrafts(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  clearTimeout(timer)
}

/** The load of saved drafts has started and not landed (nor been given up): a draft may exist that
 *  memory doesn't hold yet. */
export function isNativeChatComposerDraftLoadPending(): boolean {
  return started && !load.hydrated
}

export function resetNativeChatComposerDraftLoadForTests(): void {
  started = false
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  hydration = null
  failedLoads = 0
}
