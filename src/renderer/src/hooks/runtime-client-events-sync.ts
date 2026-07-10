import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'

export type RuntimeClientEventSubscriptionHandle = {
  unsubscribe: () => void
}

export type RuntimeClientEventsSyncDeps = {
  /** Current set of runtime environment ids that should have a live client-event
   *  subscription. Re-read on every sync and at subscribe-resolution time. */
  getDesiredEnvironmentIds: () => string[]
  subscribe: (
    environmentId: string,
    onEvent: (event: RuntimeClientEvent) => void,
    onError: (error: unknown) => void
  ) => Promise<RuntimeClientEventSubscriptionHandle>
  onEvent: (environmentId: string, event: RuntimeClientEvent) => void
  /** Base retry delay; doubles per consecutive failure up to retryMaxDelayMs. */
  retryDelayMs?: number
  retryMaxDelayMs?: number
  /** Injectable randomness for deterministic backoff-jitter tests. */
  random?: () => number
}

export type RuntimeClientEventsSync = {
  /** Reconciles live subscriptions to the desired environment set. */
  sync: () => void
  /** Tears down all subscriptions and bumps the generation so in-flight
   *  subscribes resolve into a no-op. */
  stop: () => void
}

/**
 * Manages runtime-client-event subscriptions, one per desired environment.
 *
 * Extracted from useIpcEvents so the async reconciliation — and in particular
 * the overwrite-orphan race below — is unit-testable.
 *
 * The race: a subscribe is async. If an environment id is removed from the
 * desired set while its subscribe promise is in flight (and another live
 * subscription keeps the generation from bumping), then re-added before the
 * original promise resolves, the de-dupe guard sees neither a live subscription
 * nor a pending entry and starts a SECOND subscribe. Both resolve and the second
 * `set()` previously overwrote the first's unsubscribe in the map — leaking the
 * first subscription's preload handle forever. The resolution guard keeps the
 * first winner and unsubscribes any later duplicate.
 */
export function createRuntimeClientEventsSync(
  deps: RuntimeClientEventsSyncDeps
): RuntimeClientEventsSync {
  const subscriptions = new Map<string, () => void>()
  const pending = new Set<string>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const consecutiveFailures = new Map<string, number>()
  const retryDelayMs = deps.retryDelayMs ?? 1_000
  const retryMaxDelayMs = deps.retryMaxDelayMs ?? 30_000
  const random = deps.random ?? Math.random
  let generation = 0

  const clearRetryTimer = (environmentId: string): void => {
    const retryTimer = retryTimers.get(environmentId)
    if (!retryTimer) {
      return
    }
    clearTimeout(retryTimer)
    retryTimers.delete(environmentId)
  }

  const nextRetryDelayMs = (environmentId: string): number => {
    // Why: a flat retry hammers an unreachable runtime with one socket dial per
    // tick forever. Exponential-with-cap keeps transient blips fast to recover
    // while a dead host settles at one attempt per cap window; jitter keeps
    // multiple envs from dialing in lockstep. External sync() (desired/reachable
    // transitions) still retries immediately, so recovery is not delayed.
    const failures = consecutiveFailures.get(environmentId) ?? 0
    const capped = Math.min(retryDelayMs * 2 ** Math.max(0, failures - 1), retryMaxDelayMs)
    return capped * (0.5 + random() * 0.5)
  }

  const scheduleRetry = (environmentId: string, subscribeGeneration: number): void => {
    if (retryTimers.has(environmentId)) {
      return
    }
    // Why: useIpcEvents no longer retries on every store mutation; transient
    // subscribe failures still need a bounded retry while the env remains desired.
    const retryTimer = setTimeout(() => {
      retryTimers.delete(environmentId)
      if (
        subscribeGeneration !== generation ||
        !deps.getDesiredEnvironmentIds().includes(environmentId)
      ) {
        return
      }
      sync()
    }, nextRetryDelayMs(environmentId))
    retryTimers.set(environmentId, retryTimer)
  }

  const stop = (): void => {
    generation += 1
    for (const unsubscribe of subscriptions.values()) {
      unsubscribe()
    }
    subscriptions.clear()
    pending.clear()
    for (const retryTimer of retryTimers.values()) {
      clearTimeout(retryTimer)
    }
    retryTimers.clear()
    consecutiveFailures.clear()
  }

  const sync = (): void => {
    const desiredIds = new Set(deps.getDesiredEnvironmentIds())
    for (const environmentId of retryTimers.keys()) {
      if (desiredIds.has(environmentId)) {
        continue
      }
      clearRetryTimer(environmentId)
    }
    for (const environmentId of consecutiveFailures.keys()) {
      if (!desiredIds.has(environmentId)) {
        consecutiveFailures.delete(environmentId)
      }
    }

    for (const [environmentId, unsubscribe] of subscriptions) {
      if (desiredIds.has(environmentId)) {
        continue
      }
      unsubscribe()
      subscriptions.delete(environmentId)
    }

    for (const environmentId of desiredIds) {
      if (subscriptions.has(environmentId) || pending.has(environmentId)) {
        continue
      }
      clearRetryTimer(environmentId)
      pending.add(environmentId)
      const subscribeGeneration = generation
      void deps
        .subscribe(
          environmentId,
          (event) => deps.onEvent(environmentId, event),
          (error) => {
            console.warn('[runtime-client-events] subscription error:', error)
          }
        )
        .then((subscription) => {
          pending.delete(environmentId)
          if (
            subscribeGeneration !== generation ||
            !deps.getDesiredEnvironmentIds().includes(environmentId)
          ) {
            subscription.unsubscribe()
            return
          }
          // Why: a concurrent subscribe for this environment already won the
          // overwrite-orphan race. Keep the existing subscription and unsubscribe
          // this duplicate — overwriting would lose the existing unsubscribe and
          // leak its preload handle forever.
          if (subscriptions.has(environmentId)) {
            subscription.unsubscribe()
            return
          }
          consecutiveFailures.delete(environmentId)
          subscriptions.set(environmentId, subscription.unsubscribe)
        })
        .catch((error) => {
          pending.delete(environmentId)
          if (subscribeGeneration === generation) {
            console.warn('[runtime-client-events] failed to subscribe:', error)
            // Why: only track a failure when we will actually retry this env.
            // A failure that lands after the env left the desired set must not
            // leave a stale count that makes its first retry after re-entry skip
            // the base delay.
            if (deps.getDesiredEnvironmentIds().includes(environmentId)) {
              consecutiveFailures.set(
                environmentId,
                (consecutiveFailures.get(environmentId) ?? 0) + 1
              )
              scheduleRetry(environmentId, subscribeGeneration)
            } else {
              consecutiveFailures.delete(environmentId)
            }
          }
        })
    }

    for (const environmentId of pending) {
      if (desiredIds.has(environmentId)) {
        continue
      }
      pending.delete(environmentId)
    }

    if (desiredIds.size === 0 && subscriptions.size === 0) {
      generation += 1
    }
  }

  return { sync, stop }
}
