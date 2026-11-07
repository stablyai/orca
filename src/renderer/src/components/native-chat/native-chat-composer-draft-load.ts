// Install loaded drafts plus the unload journal; input made over a still unread base is resolved
// onto what this load read, and anything resolved after this load began reading is left alone.

import {
  dirtyScopes,
  hasLocalChange,
  isNativeChatSetupDraft,
  load,
  notifyScope
} from './native-chat-composer-draft-memory'
import { draftCustody } from './native-chat-composer-draft-custody'
import { scopeInputs } from './native-chat-composer-draft-input'
import {
  claimUncommittedNativeChatDraftHandbacks,
  settleLoadedNativeChatDraftProof,
  projectStoredNativeChatDraftCustody
} from './native-chat-composer-draft-receipt-proof'
import { establishNativeChatDraftBase } from './native-chat-composer-draft-base'
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

/** An addition's own replay, applied once to the base it joins. */
export type DraftAppend = (draft: StoredNativeChatComposerDraft) => StoredNativeChatComposerDraft

/** One actual `loadAll`: what it may not publish, because a scope's own read, write or deletion
 *  came after this load began reading. It ends with that load. */
export type NativeChatDraftLoadAttempt = {
  readonly excluded: Set<string>
  readonly deletions: ((scopeKey: string, draft: StoredNativeChatComposerDraft) => boolean)[]
}

export type LoadBookkeeping = {
  hydrated: boolean
  /** Every saved draft was read; `hydrated` alone may mean the load gave up. */
  complete: boolean
  /** The load reading now, if any; a scheduled retry is not one. */
  attempt: NativeChatDraftLoadAttempt | null
}

// Bound database-open retries; after exhaustion retain memory changes and expose refused saves.
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000]

let hydration: Promise<void> | null = null
let failedLoads = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

function applyLoaded(
  attempt: NativeChatDraftLoadAttempt,
  loaded: ReadonlyMap<string, unknown>,
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
  const replayed = replayNativeChatComposerDraftJournal(drafts, journal, materialized)
  // Input or a return waiting for a base that has no saved record: the empty draft is its base.
  for (const scopeKey of [...draftCustody.keys(), ...scopeInputs.keys()]) {
    if (
      !drafts.has(scopeKey) &&
      (scopeInputs.has(scopeKey) || draftCustody.get(scopeKey)?.pending.length)
    ) {
      drafts.set(scopeKey, null)
    }
  }
  for (const [scopeKey, stored] of drafts) {
    const journaled = [...(materialized.get(scopeKey) ?? [])]
    // Its own read, write or deletion came after this load read it: this older value must not replace it.
    if (attempt.excluded.has(scopeKey)) {
      continue
    }
    if (draftCustody.get(scopeKey)?.pending.length || scopeInputs.has(scopeKey)) {
      establishNativeChatDraftBase(scopeKey, stored, journaled, committed.get(scopeKey))
      dirtyScopes.add(scopeKey)
      continue
    }
    if (hasLocalChange(scopeKey)) {
      // Its own write is still on its way and commits at the stored record; memory learns the
      // receipts kept there.
      projectStoredNativeChatDraftCustody(scopeKey, stored, stored?.handbacks ?? [])
      continue
    }
    if (!stored || attempt.deletions.some((matches) => matches(scopeKey, stored))) {
      // An unreadable record, a journaled removal, or one deleted here while loading.
      dirtyScopes.add(scopeKey)
      continue
    }
    const restaged = installStoredNativeChatComposerDraft(
      scopeKey,
      stored,
      stored.handbacks ?? [],
      { at: 'start', pending: true }
    )
    journaled.forEach((key) => draftCustody.get(scopeKey)?.journaled.add(key))
    claimUncommittedNativeChatDraftHandbacks(scopeKey, committed.get(scopeKey))
    settleLoadedNativeChatDraftProof(scopeKey, committed.get(scopeKey), journaled)
    if (replayed.has(scopeKey) || restaged || journaled.length) {
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
  load.attempt = null
  flushNativeChatComposerDrafts()
}

function retryLater(attempt: NativeChatDraftLoadAttempt, error: unknown): void {
  if (load.attempt !== attempt) {
    return
  }
  // This read can no longer publish: what it excluded ends with it.
  load.attempt = null
  if (failedLoads === 0) {
    console.warn('[native-chat-drafts] saved drafts could not be loaded', error)
  }
  const delay = RETRY_DELAYS_MS[failedLoads]
  failedLoads += 1
  releaseNativeChatComposerDraftReplaySnapshot()
  if (delay === undefined) {
    // Given up: nothing waits on a load any more, though no draft's saved base was read by it.
    load.hydrated = true
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
  if (hydration) {
    return hydration
  }
  const attempt: NativeChatDraftLoadAttempt = { excluded: new Set(), deletions: [] }
  load.attempt = attempt
  hydration = (async () => {
    removeLegacyLocalStorageNativeChatComposerDrafts()
    installNativeChatComposerDraftBroadcast()
    // The attempt's one journal snapshot, which its own scope reads share.
    const journal = captureNativeChatComposerDraftReplaySnapshot().filter(
      (entry) => !isNativeChatSetupDraft(entry.scopeKey)
    )
    const loaded = await nativeChatComposerDraftStorage().loadAll()
    // A superseded read's result publishes nothing.
    if (load.attempt === attempt) {
      applyLoaded(attempt, loaded, journal)
    }
  })().catch((error: unknown) => retryLater(attempt, error))
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
  load.attempt = null
  scopeInputs.clear()
  failedLoads = 0
  draftCustody.clear()
  resetNativeChatDraftReceiptEventsForTests()
  releaseNativeChatComposerDraftReplaySnapshot()
  startNativeChatComposerDraftJournalRunForTests()
}
