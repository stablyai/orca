// Preserve pre-hydration edits and replay appends on top of loaded drafts plus the unload journal.

import {
  dirtyScopes,
  isNativeChatSetupDraft,
  installNativeChatDraftRecord,
  load,
  nextSavedAt,
  nativeChatDraftPositions,
  notifyScope,
  records,
  reconcileRestoredImageChecks,
  type NativeChatDraftPosition
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

/** Pre-hydration appends replay over loaded drafts; ordinary edits replace them. */
export type DraftAppend = (draft: StoredNativeChatComposerDraft) => StoredNativeChatComposerDraft

/** Atomically append in storage, then replay onto hydration if that load could not have read it. */
export type AppendBeforeLoad = {
  /** In-run order, compared with the order at which a load attempt read storage. */
  readonly sequence: number
  readonly append: DraftAppend
  committed: boolean
  /** The live draft had a placement right after this append (in memory, before any load). */
  readonly placed: boolean
  /**
   * The placement this append's own storage write produced, against the stored draft that write read:
   * where the placement is in what a later load reads, if this is the last step that load holds.
   */
  committedPosition?: NativeChatDraftPosition
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

/**
 * The appends this load could not have read (made after it began reading, or never written) replayed
 * over what it read. The placement starts where the last step the read holds put it in storage, and
 * replay carries it from there: its coordinates come from the writes themselves, never from matching
 * text, so the same loaded bytes reached by two different histories place it where each put it.
 */
function withAppends(
  scopeKey: string,
  loaded: StoredNativeChatComposerDraft,
  readAtSequence: number
): DraftLoadResult {
  const appends = load.appendsBeforeLoad.get(scopeKey) ?? []
  const held = (entry: AppendBeforeLoad) => entry.committed && entry.sequence <= readAtSequence
  const missing = appends.filter((entry) => !held(entry))
  const placedThisRun = appends.some((entry) => entry.placed)
  const committedPosition = appends.findLast(held)?.committedPosition
  if (missing.length === 0) {
    return { draft: loaded, changed: false, position: committedPosition, placedThisRun }
  }
  if (committedPosition) {
    nativeChatDraftPositions.set(loaded, committedPosition)
  }
  const merged = missing.reduce((draft, entry) => entry.append(draft), loaded)
  return {
    draft: { ...merged, savedAt: nextSavedAt() },
    changed: true,
    position: nativeChatDraftPositions.get(merged),
    placedThisRun
  }
}

type DraftLoadResult = {
  draft: StoredNativeChatComposerDraft
  changed: boolean
  position?: NativeChatDraftPosition
  /** An append this run placed the caret here, whether or not that placement still stands. */
  placedThisRun: boolean
}

/**
 * The placement a loaded draft starts with. Replay may move a placement but never create or revive
 * one. A draft this run never placed opens at its start, as on a cold start. One placed this run whose
 * placement a later step retired (a replacing append) gets none. Otherwise the live placement's
 * lineage decides: one already applied (or given up) is never armed again, and a pending one stands
 * where the writes and replay put it in the loaded text.
 */
function loadedDraftPosition(
  { changed, position, placedThisRun }: DraftLoadResult,
  live: StoredNativeChatComposerDraft | undefined
): NativeChatDraftPosition | undefined {
  const livePosition = live && nativeChatDraftPositions.get(live)
  if (!livePosition) {
    return changed || placedThisRun ? undefined : { at: 'start', pending: true }
  }
  if (!livePosition.pending || !position) {
    return undefined
  }
  return { ...position, pending: true }
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
      continue
    }
    if (!stored || load.deletionsBeforeLoad.some((matches) => matches(scopeKey, stored))) {
      // An unreadable record, a journaled removal, or one deleted here while loading.
      dirtyScopes.add(scopeKey)
      continue
    }
    const result = withAppends(scopeKey, stored, readAtSequence)
    const { draft, changed } = result
    reconcileRestoredImageChecks(scopeKey, draft.images, records.get(scopeKey)?.images ?? [])
    const live = records.get(scopeKey)
    installNativeChatDraftRecord(scopeKey, draft, loadedDraftPosition(result, live))
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
}
