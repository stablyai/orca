// Preserve pre-hydration edits and replay appends on top of loaded drafts plus the unload journal.

import {
  dirtyScopes,
  isNativeChatSetupDraft,
  load,
  nextSavedAt,
  nativeChatDraftPositions,
  notifyScope,
  type NativeChatDraftPosition
} from './native-chat-composer-draft-memory'
import { draftCustody, knownDraftBases } from './native-chat-composer-draft-custody'
import {
  claimUncommittedNativeChatDraftHandbacks,
  settleLoadedNativeChatDraftProof,
  projectStoredNativeChatDraftCustody
} from './native-chat-composer-draft-receipt-proof'
import { establishNativeChatDraftBase } from './native-chat-composer-draft-base'
import { resetNativeChatDraftRetirementsForTests } from './native-chat-composer-draft-retirement'
import {
  noticeNativeChatDraftReceipts,
  resetNativeChatDraftReceiptEventsForTests
} from './native-chat-composer-draft-receipt-events'
import { installStoredNativeChatComposerDraft } from './native-chat-composer-draft-restore'
import {
  flushNativeChatComposerDrafts,
  installNativeChatComposerDraftBroadcast
} from './native-chat-composer-draft-persistence'
import {
  captureNativeChatComposerDraftReplaySnapshot,
  releaseNativeChatComposerDraftReplaySnapshot,
  replayNativeChatComposerDraftJournal,
  startNativeChatComposerDraftJournalRunForTests,
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
  /** Every saved draft was read; `hydrated` alone may mean the load gave up. */
  complete: boolean
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
  const committed = new Map(drafts)
  const materialized = new Map<string, Set<string>>()
  for (const scopeKey of replayNativeChatComposerDraftJournal(drafts, journal, materialized)) {
    dirtyScopes.add(scopeKey)
  }
  for (const [scopeKey, custody] of draftCustody) {
    // A hand-back that arrived first and found no saved record: the empty draft is its base.
    if (custody.pending.length && !drafts.has(scopeKey)) {
      drafts.set(scopeKey, null)
    }
  }
  for (const [scopeKey, appends] of load.appendsBeforeLoad) {
    // Appended with nothing saved before: an empty draft is what the load would have read.
    if (!drafts.has(scopeKey) && appends.some((entry) => !entry.committed)) {
      drafts.set(scopeKey, { text: '', images: [], savedAt: 0 })
    }
  }
  for (const [scopeKey, stored] of drafts) {
    const journaled = [...(materialized.get(scopeKey) ?? [])]
    // Its own read already gave this scope its complete base; this older snapshot must not replace it.
    if (knownDraftBases.has(scopeKey)) {
      continue
    }
    if (draftCustody.get(scopeKey)?.pending.length) {
      establishNativeChatDraftBase(scopeKey, stored, journaled, committed.get(scopeKey))
      dirtyScopes.add(scopeKey)
      continue
    }
    if (load.editedBeforeLoad.has(scopeKey)) {
      // Its pending write commits at the stored record; memory learns the receipts kept there.
      projectStoredNativeChatDraftCustody(scopeKey, stored, stored?.handbacks ?? [])
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
    journaled.forEach((key) => draftCustody.get(scopeKey)?.journaled.add(key))
    claimUncommittedNativeChatDraftHandbacks(scopeKey, committed.get(scopeKey))
    settleLoadedNativeChatDraftProof(scopeKey, committed.get(scopeKey), journaled)
    if (changed || restaged || journaled.length) {
      dirtyScopes.add(scopeKey)
    }
    notifyScope(scopeKey)
  }
  releaseNativeChatComposerDraftReplaySnapshot()
  for (const scopeKey of draftCustody.keys()) {
    noticeNativeChatDraftReceipts(scopeKey)
  }
  load.hydrated = true
  load.complete = true
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
  releaseNativeChatComposerDraftReplaySnapshot()
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
    // The attempt's one journal snapshot, which its own scope reads share.
    const journal = captureNativeChatComposerDraftReplaySnapshot().filter(
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
  knownDraftBases.clear()
  resetNativeChatDraftReceiptEventsForTests()
  resetNativeChatDraftRetirementsForTests()
  releaseNativeChatComposerDraftReplaySnapshot()
  startNativeChatComposerDraftJournalRunForTests()
}
