// Persist undelivered closes across disconnect/reload; replay once reachable or authoritative snapshots resurrect optimistically removed tabs.

import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS,
  pairedTerminalTabCloseIntentKey,
  type PairedTerminalTabCloseIntent
} from '../../../shared/paired-terminal-tab-close-intent'
import type { PairedTerminalTabCloseIntentsByEnvironment } from './paired-terminal-tab-close-intents'
import {
  getRuntimeEnvironmentRevision,
  isRuntimeEnvironmentContinuationPending
} from './runtime-environment-revision'
import {
  clearWebSessionCloseIntent,
  makeWebSessionCloseIntentDurable,
  recordWebSessionCloseIntent
} from './web-session-close-intent'
import type { WebSessionIntentOwner } from './web-session-intent-owner'
import { acceptReplayedWebSessionTabsSnapshot } from './web-session-tabs-sync/state'

/** Bounded so a host that keeps failing the close hands the tab back instead of hiding it forever. */
export const MAX_WEB_SESSION_CLOSE_REPLAY_ATTEMPTS = 3

/** Passed rather than imported: the store reaches this module, so importing it back closes a cycle. */
export type PairedTerminalTabCloseIntentStore = {
  getIntents: () => PairedTerminalTabCloseIntentsByEnvironment | undefined
  record: (environmentId: string, intent: PairedTerminalTabCloseIntent) => void
  clear: (environmentId: string, intentKeys: readonly string[]) => void
}

export type WebSessionCloseReplay = {
  owner: WebSessionIntentOwner
  worktreeId: string
  /** Every host id the close suppressed; the first is the one sent. */
  hostTabIds: readonly string[]
  intentKey: string
  force?: true
}

// Session-scoped on purpose: after a reload a held close starts a fresh attempt count.
const attemptsByIntent = new Map<string, { attempts: number; inFlight: boolean }>()
// Held closes also hidden under the current pairing while their own was unknown or undecided.
const hiddenUnderCurrentPairing = new Set<string>()

function attemptKey(environmentId: string, intentKey: string): string {
  return `${environmentId}\0${intentKey}`
}

function listHeldIntents(
  store: Pick<PairedTerminalTabCloseIntentStore, 'getIntents'>,
  environmentId: string
): readonly PairedTerminalTabCloseIntent[] {
  return store.getIntents()?.[environmentId] ?? []
}

function intentOwner(
  environmentId: string,
  intent: PairedTerminalTabCloseIntent
): WebSessionIntentOwner {
  return intent.pairingRevision !== undefined
    ? { environmentId, pairingRevision: intent.pairingRevision }
    : { environmentId }
}

function hideHeldClose(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabIds: readonly string[]
) {
  for (const hostTabId of hostTabIds) {
    recordWebSessionCloseIntent(owner, worktreeId, hostTabId, Date.now())
    makeWebSessionCloseIntentDurable(owner, worktreeId, hostTabId)
  }
}

function revealHeldClose(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabIds: readonly string[]
) {
  for (const hostTabId of hostTabIds) {
    clearWebSessionCloseIntent(owner, worktreeId, hostTabId)
  }
}

/** Remove held closes through this path so eviction/age pruning also releases their hides, except delivered closes awaiting host removal. Reaccept unchanged snapshots after release or tabs stay hidden until host changes. */
function changeHeldIntents(
  store: Pick<PairedTerminalTabCloseIntentStore, 'getIntents'>,
  environmentId: string,
  change: () => void,
  stillHidden: ReadonlySet<string> = new Set()
): void {
  const before = listHeldIntents(store, environmentId)
  change()
  const after = listHeldIntents(store, environmentId)
  const kept = new Set(after.map(pairedTerminalTabCloseIntentKey))
  const stillHeldTabs = new Set(
    after.flatMap((intent) => intent.hostTabIds.map((id) => `${intent.worktreeId}\0${id}`))
  )
  const revealedWorktreeIds = new Set<string>()
  for (const intent of before) {
    const key = pairedTerminalTabCloseIntentKey(intent)
    if (kept.has(key)) {
      continue
    }
    attemptsByIntent.delete(attemptKey(environmentId, key))
    const hidUnderCurrent = hiddenUnderCurrentPairing.delete(attemptKey(environmentId, key))
    if (!stillHidden.has(key)) {
      revealHeldClose(intentOwner(environmentId, intent), intent.worktreeId, intent.hostTabIds)
      // Only the hide this close laid: a fresh close of the same tab may hide there too.
      if (hidUnderCurrent) {
        revealHeldClose(
          { environmentId },
          intent.worktreeId,
          intent.hostTabIds.filter((id) => !stillHeldTabs.has(`${intent.worktreeId}\0${id}`))
        )
      }
      revealedWorktreeIds.add(intent.worktreeId)
    }
  }
  for (const worktreeId of revealedWorktreeIds) {
    acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
  }
}

/** Keeps an unsent user close, hiding its tab; a repeat for the same tab keeps its attempt count. */
export function holdWebSessionCloseForReplay(
  store: PairedTerminalTabCloseIntentStore,
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabIds: readonly string[],
  options: { force?: boolean } = {}
): void {
  hideHeldClose(owner, worktreeId, hostTabIds)
  if (!worktreeId || !hostTabIds[0]) {
    return
  }
  const { environmentId } = owner
  changeHeldIntents(store, environmentId, () =>
    store.record(environmentId, {
      hostTabIds: [...hostTabIds],
      worktreeId,
      closedAt: Date.now(),
      ...(owner.pairingRevision !== undefined ? { pairingRevision: owner.pairingRevision } : {}),
      ...(options.force ? { force: true as const } : {})
    })
  )
}

/** Rehide all listed held closes and return due replays; listed tabs prove reachability. Incomplete inventories make absence inconclusive, so unlisted closes end only at delivery, give-up, cap or age bound. */
export function takeDueWebSessionCloseReplays(
  store: PairedTerminalTabCloseIntentStore,
  environmentId: string,
  worktreeId: string,
  presentHostTabIds: ReadonlySet<string>
): WebSessionCloseReplay[] {
  const now = Date.now()
  const currentRevision = getRuntimeEnvironmentRevision(environmentId)
  const dropped: string[] = []
  const due: WebSessionCloseReplay[] = []
  for (const intent of listHeldIntents(store, environmentId)) {
    if (
      intent.worktreeId !== worktreeId ||
      !intent.hostTabIds.some((hostTabId) => presentHostTabIds.has(hostTabId))
    ) {
      continue
    }
    const intentKey = pairedTerminalTabCloseIntentKey(intent)
    const key = attemptKey(environmentId, intentKey)
    // Reload/re-pair snapshots can precede pairing identity. Unknown is not mismatch: hide under the current key without sending until checked; the age bound limits unresolved holds.
    const expired = now - intent.closedAt > PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS
    if (
      !expired &&
      intent.pairingRevision !== undefined &&
      (currentRevision === undefined ||
        isRuntimeEnvironmentContinuationPending(environmentId, intent.pairingRevision))
    ) {
      hideHeldClose({ environmentId }, intent.worktreeId, intent.hostTabIds)
      hiddenUnderCurrentPairing.add(key)
      continue
    }
    // Never send old-pairing closes to replacement hosts; age-bound closes can no longer justify hiding.
    if (expired || intent.pairingRevision !== currentRevision) {
      dropped.push(intentKey)
      continue
    }
    const owner = intentOwner(environmentId, intent)
    // Rehide in-flight closes too: reload/subscription reinstall clears intent while snapshots still list the tab.
    hideHeldClose(owner, intent.worktreeId, intent.hostTabIds)
    const attempt = attemptsByIntent.get(key) ?? { attempts: 0, inFlight: false }
    if (attempt.inFlight) {
      continue
    }
    attempt.inFlight = true
    attempt.attempts += 1
    attemptsByIntent.set(key, attempt)
    due.push({
      owner,
      worktreeId: intent.worktreeId,
      hostTabIds: intent.hostTabIds,
      intentKey,
      ...(intent.force ? { force: true as const } : {})
    })
  }
  if (dropped.length > 0) {
    changeHeldIntents(store, environmentId, () => store.clear(environmentId, dropped))
  }
  return due
}

/** 'gave-up' means the host kept refusing the close; its tab is shown again. */
export function settleWebSessionCloseReplay(
  store: PairedTerminalTabCloseIntentStore,
  replay: WebSessionCloseReplay,
  delivered: boolean
): 'done' | 'retry' | 'gave-up' {
  const { environmentId } = replay.owner
  const key = attemptKey(environmentId, replay.intentKey)
  const attempt = attemptsByIntent.get(key)
  const held = listHeldIntents(store, environmentId).some(
    (intent) => pairedTerminalTabCloseIntentKey(intent) === replay.intentKey
  )
  if (!attempt || !held) {
    attemptsByIntent.delete(key)
    return 'done'
  }
  attempt.inFlight = false
  if (delivered || attempt.attempts >= MAX_WEB_SESSION_CLOSE_REPLAY_ATTEMPTS) {
    changeHeldIntents(
      store,
      environmentId,
      () => store.clear(environmentId, [replay.intentKey]),
      delivered ? new Set([replay.intentKey]) : undefined
    )
    return delivered ? 'done' : 'gave-up'
  }
  return 'retry'
}

/** The held closes of a store whose actions may be absent (minimal test assemblies). */
export function pairedTerminalTabCloseIntentStoreOf(
  getState: () => {
    pairedTerminalTabCloseIntentsByEnvironment?: PairedTerminalTabCloseIntentsByEnvironment
    recordPairedTerminalTabCloseIntent?: PairedTerminalTabCloseIntentStore['record']
    clearPairedTerminalTabCloseIntents?: PairedTerminalTabCloseIntentStore['clear']
  }
): PairedTerminalTabCloseIntentStore {
  return {
    getIntents: () => getState().pairedTerminalTabCloseIntentsByEnvironment,
    record: (environmentId, intent) =>
      getState().recordPairedTerminalTabCloseIntent?.(environmentId, intent),
    clear: (environmentId, intentKeys) =>
      getState().clearPairedTerminalTabCloseIntents?.(environmentId, intentKeys)
  }
}

/** Reconcile the full catalog, including servers removed while closed: discard absent/retired peers’ closes. Proven same-machine re-pairs persist the new pairing so reload still replays them. */
export function reconcileWebSessionCloseReplaysWithCatalog(
  store: PairedTerminalTabCloseIntentStore,
  catalog: {
    listed: ReadonlySet<string>
    retired: readonly string[]
    sameHost: readonly { id: string; fromRevision: number; toRevision: number }[]
  }
): void {
  for (const [environmentId, held] of Object.entries(store.getIntents() ?? {})) {
    if (!catalog.listed.has(environmentId) || catalog.retired.includes(environmentId)) {
      const keys = held.map(pairedTerminalTabCloseIntentKey)
      changeHeldIntents(store, environmentId, () => store.clear(environmentId, keys))
    }
  }
  for (const { id: environmentId, fromRevision, toRevision } of catalog.sameHost) {
    const now = Date.now()
    const moved = listHeldIntents(store, environmentId).filter(
      (intent) =>
        intent.pairingRevision === fromRevision &&
        now - intent.closedAt <= PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS
    )
    if (moved.length === 0) {
      continue
    }
    const rebased = moved.map((intent) => ({ ...intent, pairingRevision: toRevision }))
    // Un-hides under the old pairing; the new one hides the same tabs below.
    changeHeldIntents(store, environmentId, () => {
      store.clear(environmentId, moved.map(pairedTerminalTabCloseIntentKey))
      rebased.forEach((intent) => store.record(environmentId, intent))
    })
    for (const intent of rebased) {
      hideHeldClose(intentOwner(environmentId, intent), intent.worktreeId, intent.hostTabIds)
    }
    // Request a snapshot after resolving re-pair identity; idle hosts may publish none to trigger replay.
    const worktreeIds = [...new Set(rebased.map((intent) => intent.worktreeId))]
    // Lazy: the snapshot module reaches the store, which loads this module.
    void import('./web-runtime-session-snapshot').then(({ refreshWebRuntimeSessionTabsSnapshot }) =>
      worktreeIds.forEach(
        (worktreeId) =>
          void refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId, {
            expectedEnvironmentPairingRevision: toRevision
          })
      )
    )
  }
}

/** Sends the closes a received host snapshot made due; see `takeDueWebSessionCloseReplays`. */
export function replayWebSessionClosesDueForSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult | { worktree: string; removed: true },
  store: PairedTerminalTabCloseIntentStore
): void {
  if (!('tabs' in snapshot) || listHeldIntents(store, environmentId).length === 0) {
    return
  }
  const presentHostTabIds = new Set(
    snapshot.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id))
  )
  const due = takeDueWebSessionCloseReplays(
    store,
    environmentId,
    snapshot.worktree,
    presentHostTabIds
  )
  if (due.length === 0) {
    return
  }
  // Lazy: the lifecycle module reaches the store, which loads this module.
  void import('./web-runtime-session-tab-lifecycle').then(({ replayWebSessionTabCloses }) =>
    replayWebSessionTabCloses(environmentId, due)
  )
}

export function resetWebSessionCloseReplaysForTests(): void {
  attemptsByIntent.clear()
  hiddenUnderCurrentPairing.clear()
}
