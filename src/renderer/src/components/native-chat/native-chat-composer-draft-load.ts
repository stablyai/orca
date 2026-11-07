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
  nativeChatComposerDraftJournalReplayKey,
  snapshotNativeChatComposerDraftJournal,
  type NativeChatComposerDraftJournalSnapshot
} from './native-chat-composer-draft-journal'
import {
  nativeChatComposerDraftStorage,
  parseStoredNativeChatComposerDraft,
  removeLegacyLocalStorageNativeChatComposerDrafts,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'
import {
  beginNativeChatDraftLoadAttempt,
  finishNativeChatDraftLoadAttempt,
  type NativeChatDraftLoadAttempt
} from './native-chat-composer-draft-load-attempt'

/** Pre-hydration appends replay over loaded drafts; ordinary edits replace them. */
export type DraftAppend = (draft: StoredNativeChatComposerDraft) => StoredNativeChatComposerDraft

/** Atomically append in storage, then replay onto hydration if that load could not have read it. */
export type AppendBeforeLoad = {
  /** In-run order, compared with the order at which a load attempt read storage. */
  readonly sequence: number
  readonly append: DraftAppend
  committed: boolean
  retired?: boolean
  applied?: { input: unknown; output: StoredNativeChatComposerDraft | null }
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
  attempt: NativeChatDraftLoadAttempt | null
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
    (entry) => !entry.retired && (!entry.committed || entry.sequence > readAtSequence)
  )
  if (missing.length === 0) {
    return { draft: loaded, changed: false }
  }
  const merged = missing.reduce((draft, entry) => entry.append(draft), loaded)
  return {
    draft: { ...merged, savedAt: nextSavedAt() },
    changed: true,
    appends: missing,
    position: nativeChatDraftPositions.get(merged)
  }
}

type DraftLoadResult = {
  draft: StoredNativeChatComposerDraft
  changed: boolean
  position?: NativeChatDraftPosition
  appends?: readonly AppendBeforeLoad[]
}

function applyLoaded(
  loaded: ReadonlyMap<string, unknown>,
  readAtSequence: number,
  journal: NativeChatComposerDraftJournalSnapshot,
  attempt: NativeChatDraftLoadAttempt
): void {
  const drafts = new Map<string, StoredNativeChatComposerDraft | null>()
  for (const [scopeKey, value] of loaded) {
    if (!isNativeChatSetupDraft(scopeKey)) {
      const draft = parseStoredNativeChatComposerDraft(value)
      if (
        !draft ||
        ![...attempt.exclusions].some((selection) =>
          selection.values.get(scopeKey)?.has(JSON.stringify(draft))
        )
      ) {
        drafts.set(scopeKey, draft)
      }
    }
  }
  const included = journal.filter(
    (entry) =>
      ![...attempt.exclusions].some((selection) =>
        selection.journal.has(nativeChatComposerDraftJournalReplayKey(entry))
      )
  )
  const journalInputs = new Map<string, Set<string>>()
  for (const entry of included) {
    const inputs = journalInputs.get(entry.scopeKey) ?? new Set<string>()
    inputs.add(nativeChatComposerDraftJournalReplayKey(entry))
    journalInputs.set(entry.scopeKey, inputs)
  }
  for (const scopeKey of replayNativeChatComposerDraftJournal(drafts, included)) {
    dirtyScopes.add(scopeKey)
  }
  for (const [scopeKey, appends] of load.appendsBeforeLoad) {
    // Appended with nothing saved before: an empty draft is what the load would have read.
    if (!drafts.has(scopeKey) && appends.some((entry) => !entry.retired && !entry.committed)) {
      drafts.set(scopeKey, { text: '', images: [], savedAt: 0 })
    }
  }
  for (const [scopeKey, stored] of drafts) {
    if (load.editedBeforeLoad.has(scopeKey)) {
      continue
    }
    if (
      stored &&
      [...attempt.exclusions].some((selection) =>
        selection.values.get(scopeKey)?.has(JSON.stringify(stored))
      )
    ) {
      dirtyScopes.delete(scopeKey)
      continue
    }
    if (!stored || load.deletionsBeforeLoad.some((matches) => matches(scopeKey, stored))) {
      // An unreadable record, a journaled removal, or one deleted here while loading.
      dirtyScopes.add(scopeKey)
      continue
    }
    const { draft, changed, position, appends } = withAppends(scopeKey, stored, readAtSequence)
    attempt.installed.set(draft, {
      input: loaded.get(scopeKey),
      journal: journalInputs.get(scopeKey) ?? new Set(),
      appends: appends ?? []
    })
    reconcileRestoredImageChecks(scopeKey, draft.images, records.get(scopeKey)?.images ?? [])
    installNativeChatDraftRecord(
      scopeKey,
      draft,
      position ?? (changed ? undefined : { at: 'start', pending: true })
    )
    if (changed) {
      dirtyScopes.add(scopeKey)
    }
    notifyScope(scopeKey)
  }
  load.hydrated = true
  load.editedBeforeLoad.clear()
  load.appendsBeforeLoad.clear()
  load.deletionsBeforeLoad.length = 0
  attempt.exclusions.clear()
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
    const attempt = beginNativeChatDraftLoadAttempt()
    load.attempt = attempt
    try {
      applyLoaded(
        await nativeChatComposerDraftStorage().loadAll(),
        readAtSequence,
        journal,
        attempt
      )
    } finally {
      if (load.attempt === attempt) {
        load.attempt = null
      }
      finishNativeChatDraftLoadAttempt(attempt)
    }
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
