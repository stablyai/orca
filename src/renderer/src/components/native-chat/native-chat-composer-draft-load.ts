// Preserve pre-hydration edits and replay appends on top of loaded drafts plus the unload journal.

import {
  dirtyScopes,
  isNativeChatSetupDraft,
  load,
  nextSavedAt,
  nativeChatDraftPositions,
  notifyScope,
  records,
  type NativeChatDraftPosition
} from './native-chat-composer-draft-memory'
import {
  draftCustody,
  referencedNativeChatDraftPaths,
  scopeCustody,
  withHandbackReceipts
} from './native-chat-composer-draft-custody'
import { installStoredNativeChatComposerDraft } from './native-chat-composer-draft-restore'
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

/** Pre-hydration appends replay over loaded drafts; ordinary edits replace them. */
export type DraftAppend = (draft: StoredNativeChatComposerDraft) => StoredNativeChatComposerDraft

/** Atomically append in storage, then replay onto hydration if that load could not have read it. */
export type AppendBeforeLoad = {
  /** In-run order, compared with the order at which a load attempt read storage. */
  readonly sequence: number
  readonly append: DraftAppend
  committed: boolean
}

export type LoadBookkeeping = {
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

// Bound database-open retries; after exhaustion retain memory changes and expose refused saves.
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000]

let hydration: Promise<void> | null = null
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
  return {
    draft: { ...merged, savedAt: nextSavedAt() },
    changed: true,
    position: nativeChatDraftPositions.get(merged)
  }
}

type DraftLoadResult = {
  draft: StoredNativeChatComposerDraft
  changed: boolean
  position?: NativeChatDraftPosition
}

function applyLoaded(
  loaded: ReadonlyMap<string, unknown>,
  readAtSequence: number,
  journal: NativeChatComposerDraftJournalSnapshot
): void {
  const drafts = new Map<string, StoredNativeChatComposerDraft | null>()
  for (const [scopeKey, value] of loaded) {
    if (!isNativeChatSetupDraft(scopeKey)) {
      drafts.set(scopeKey, parseStoredNativeChatComposerDraft(value))
    }
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
      if (stored && keepStoredCustody(scopeKey, stored)) {
        dirtyScopes.add(scopeKey)
      }
      continue
    }
    if (!stored || load.deletionsBeforeLoad.some((matches) => matches(scopeKey, stored))) {
      // An unreadable record, a journaled removal, or one deleted here while loading.
      dirtyScopes.add(scopeKey)
      continue
    }
    const { draft, changed, position } = withAppends(scopeKey, stored, readAtSequence)
    const restaged = installStoredNativeChatComposerDraft(
      scopeKey,
      draft,
      stored.handbacks ?? [],
      position ?? (changed ? undefined : { at: 'start', pending: true })
    )
    if (changed || restaged) {
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

/** An edit made before the load replaces stored content, never the receipts and provenance stored with it. */
function keepStoredCustody(scopeKey: string, stored: StoredNativeChatComposerDraft): boolean {
  const referenced = referencedNativeChatDraftPaths(records.get(scopeKey))
  const sourcePaths = (stored.sourcePaths ?? []).filter((path) => referenced.has(path))
  if (!stored.handbacks?.length && !sourcePaths.length) {
    return false
  }
  const custody = scopeCustody(scopeKey, nextSavedAt())
  const before = custody.handbacks.length + custody.sourcePaths.length
  custody.handbacks = withHandbackReceipts(custody.handbacks, stored.handbacks ?? [])
  custody.sourcePaths = [...new Set([...custody.sourcePaths, ...sourcePaths])]
  custody.owner ??= stored.owner
  if (custody.handbacks.length + custody.sourcePaths.length === before) {
    return false
  }
  custody.savedAt = nextSavedAt()
  return true
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
  hydration ??= (async () => {
    removeLegacyLocalStorageNativeChatComposerDrafts()
    installNativeChatComposerDraftBroadcast()
    // Why read here: storage applies changes in order, so this load reads every append made so far.
    const readAtSequence = load.appendSequence
    const journal = snapshotNativeChatComposerDraftJournal().filter(
      (entry) => !isNativeChatSetupDraft(entry.scopeKey)
    )
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

export function resetNativeChatComposerDraftLoadForTests(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  hydration = null
  failedLoads = 0
  draftCustody.clear()
}
