import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'

export const AI_VAULT_SEARCH_COVERAGE_POLL_MS = 4_000
/** Ceiling for the doubling retry gap, so a host that is simply gone costs one read every 32s. */
export const AI_VAULT_SEARCH_COVERAGE_RETRY_MAX_MS = 32_000

/**
 * Phases that advance on their own. `idle` is not one of them: nothing moves an idle index
 * until someone searches or presses "Index now", and the host pushes that transition.
 */
const SELF_ADVANCING_PHASES: ReadonlySet<string> = new Set(['discovering', 'indexing', 'updating'])

type Snapshot = {
  coverage: AiVaultSearchCoverage | null
  busy: boolean
  /** A read or a control action did not land; both read the same to the user. */
  failed: boolean
  /** The control action itself was refused, so the user's change was not saved. */
  controlFailed: boolean
  /** Renderer clock of the newest read, so callers never subtract the host's clock from ours. */
  observedAt: number
  /** Renderer clock of the first read that reported the run now on screen. */
  phaseSince: number
}

/** Identity of one indexing run, so a re-read of the same run does not restart its age. */
function runKey(coverage: AiVaultSearchCoverage | null): string {
  const indexing = coverage?.indexing
  return indexing ? `${indexing.phase}:${indexing.startedAt}` : ''
}

/** Host clock of the run a reading describes; runs are identified by when they began. */
function runStartedAt(coverage: AiVaultSearchCoverage | null): number | undefined {
  return coverage?.indexing?.startedAt
}

/** Settings, status bar and search share a single observation per index owner. */
export function createSearchCoverageStore() {
  let snapshot: Snapshot = {
    coverage: null,
    busy: false,
    failed: false,
    controlFailed: false,
    observedAt: 0,
    phaseSince: 0
  }
  let generation = 0
  let stop: (() => void) | null = null
  let unsubscribeChanged: (() => void) | null = null
  let unsubscribeFocus: (() => void) | null = null
  // Why: a paired web client has no push channel, so a standing visibility-gated interval is its
  // only way to learn that the runtime's index moved. Desktop learns it from the host instead.
  let changePush = false
  let readWhenIdle = false
  // Why: a host that refuses every read must not be asked every 4s forever. The interval keeps
  // ticking so visibility gating and the phase rule stay in one place; the gap is what grows.
  let retryDelayMs = AI_VAULT_SEARCH_COVERAGE_POLL_MS
  let retryNotBefore = 0
  const listeners = new Set<() => void>()

  const clearRetryBackoff = (): void => {
    retryDelayMs = AI_VAULT_SEARCH_COVERAGE_POLL_MS
    retryNotBefore = 0
  }

  // Why: an index at a resting phase cannot change until someone acts on it, and the host pushes
  // every action it takes; a reading we do not hold or could not confirm keeps the interval alive.
  const shouldPoll = (): boolean => {
    if (!listeners.size) {
      return false
    }
    if (!changePush) {
      return true
    }
    const phase = snapshot.coverage?.indexing?.phase
    if (phase) {
      return SELF_ADVANCING_PHASES.has(phase)
    }
    return snapshot.coverage === null
  }

  const syncPolling = (): void => {
    const wanted = shouldPoll()
    if (wanted === (stop !== null)) {
      return
    }
    if (wanted) {
      stop = installWindowVisibilityInterval({
        // Only the interval waits out the backoff; a focus, a host push or a control action is an
        // explicit signal and reads at once.
        run: () => {
          if (Date.now() < retryNotBefore) {
            return
          }
          void refresh()
        },
        intervalMs: AI_VAULT_SEARCH_COVERAGE_POLL_MS
      })
      return
    }
    stop?.()
    stop = null
  }

  const publish = (next: Partial<Snapshot>): void => {
    snapshot = { ...snapshot, ...next }
    listeners.forEach((listener) => listener())
    syncPolling()
  }

  const record = (coverage: AiVaultSearchCoverage): void => {
    clearRetryBackoff()
    const observedAt = Date.now()
    const sameRun = runKey(coverage) === runKey(snapshot.coverage)
    publish({
      coverage,
      failed: false,
      observedAt,
      phaseSince: sameRun ? snapshot.phaseSince : observedAt
    })
  }

  let pending: Promise<void> | null = null
  const refresh = (afterControl = false): Promise<void> => {
    if (snapshot.busy && !afterControl) {
      // The control action owns the next read; remember that someone said this reading is stale.
      readWhenIdle = true
      return Promise.resolve()
    }
    readWhenIdle = false
    if (pending) {
      return pending
    }
    const issued = generation
    const request = (async () => {
      try {
        const coverage = await window.api.aiVault.searchCoverage()
        if (issued === generation) {
          record(coverage)
        }
      } catch {
        if (issued === generation) {
          retryNotBefore = Date.now() + retryDelayMs
          retryDelayMs = Math.min(retryDelayMs * 2, AI_VAULT_SEARCH_COVERAGE_RETRY_MAX_MS)
          publish({ coverage: null, failed: true })
        }
      }
    })().finally(() => {
      if (pending === request) {
        pending = null
      }
    })
    pending = request
    return request
  }

  return {
    getSnapshot: () => snapshot,
    refresh: () => refresh(),
    /** Publishes a read the caller already holds; a search result carries the freshest coverage. */
    observe(coverage: AiVaultSearchCoverage): void {
      if (snapshot.busy) {
        return
      }
      const held = runStartedAt(snapshot.coverage)
      const offered = runStartedAt(coverage)
      // An answer from a run that began before the one we hold describes a past the poll has left.
      if (held !== undefined && offered !== undefined && offered < held) {
        return
      }
      record(coverage)
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (listeners.size === 1) {
        unsubscribeChanged =
          window.api.aiVault.onSearchIndexingChanged?.(() => {
            // The host just acted, so whatever made the last read fail may be over.
            clearRetryBackoff()
            void refresh()
          }) ?? null
        changePush = unsubscribeChanged !== null
        unsubscribeFocus = window.api.aiVault.onWindowFocused?.(() => void refresh()) ?? null
      }
      syncPolling()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          unsubscribeChanged?.()
          unsubscribeChanged = null
          unsubscribeFocus?.()
          unsubscribeFocus = null
        }
        syncPolling()
      }
    },
    async control(action: () => Promise<void>): Promise<void> {
      if (snapshot.busy) {
        return
      }
      const controlled = ++generation
      pending = null
      publish({ busy: true, failed: false, controlFailed: false })
      try {
        await action()
        if (controlled === generation) {
          await refresh(true)
        }
      } catch {
        if (controlled === generation) {
          publish({ failed: true, controlFailed: true })
        }
      } finally {
        if (controlled === generation) {
          publish({ busy: false })
          if (readWhenIdle) {
            void refresh()
          }
        }
      }
    }
  }
}

const stores = new Map<string, ReturnType<typeof createSearchCoverageStore>>()
export function searchCoverageStore(ownerKey: string) {
  let store = stores.get(ownerKey)
  if (!store) {
    store = createSearchCoverageStore()
    stores.set(ownerKey, store)
  }
  return store
}
