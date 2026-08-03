import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'

export type RuntimeClientEventSubscriptionHandle = {
  unsubscribe: () => void
}

export type RuntimeClientEventsSyncDeps = {
  /** Current set of runtime environment ids that should have a live client-event
   *  subscription. Re-read on every sync and at subscribe-resolution time. */
  getDesiredEnvironmentIds: () => string[]
  /** Changes when an environment's transport generation requires a fresh subscription. */
  getSubscriptionKey?: (environmentId: string) => string
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
  const subscriptions = new Map<string, { key: string; unsubscribe: () => void }>()
  const pending = new Map<string, { key: string; generation: number }>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const consecutiveFailures = new Map<string, { key: string; count: number }>()
  const retryDelayMs = deps.retryDelayMs ?? 1_000
  const retryMaxDelayMs = deps.retryMaxDelayMs ?? 30_000
  const random = deps.random ?? Math.random
  const getSubscriptionKey = deps.getSubscriptionKey ?? ((environmentId: string) => environmentId)
  let generation = 0

  const clearRetryTimer = (environmentId: string): void => {
    const retryTimer = retryTimers.get(environmentId)
    if (!retryTimer) {
      return
    }
    clearTimeout(retryTimer)
    retryTimers.delete(environmentId)
  }

  const nextRetryDelayMs = (environmentId: string, subscriptionKey: string): number => {
    // Why: a flat retry hammers an unreachable runtime with one socket dial per
    // tick forever. Exponential-with-cap keeps transient blips fast to recover
    // while a dead host settles at one attempt per cap window; jitter keeps
    // multiple envs from dialing in lockstep. External sync() (desired/reachable
    // transitions) still retries immediately, so recovery is not delayed.
    const failure = consecutiveFailures.get(environmentId)
    const failures = failure?.key === subscriptionKey ? failure.count : 0
    const capped = Math.min(retryDelayMs * 2 ** Math.max(0, failures - 1), retryMaxDelayMs)
    return capped * (0.5 + random() * 0.5)
  }

  const scheduleRetry = (
    environmentId: string,
    subscriptionKey: string,
    subscribeGeneration: number
  ): void => {
    if (retryTimers.has(environmentId)) {
      return
    }
    // Why: useIpcEvents no longer retries on every store mutation; transient
    // subscribe failures still need a bounded retry while the env remains desired.
    const retryTimer = setTimeout(
      () => {
        retryTimers.delete(environmentId)
        if (
          subscribeGeneration !== generation ||
          !deps.getDesiredEnvironmentIds().includes(environmentId) ||
          getSubscriptionKey(environmentId) !== subscriptionKey
        ) {
          return
        }
        sync()
      },
      nextRetryDelayMs(environmentId, subscriptionKey)
    )
    retryTimers.set(environmentId, retryTimer)
  }

  const stop = (): void => {
    generation += 1
    for (const subscription of subscriptions.values()) {
      subscription.unsubscribe()
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

    for (const [environmentId, subscription] of subscriptions) {
      if (desiredIds.has(environmentId) && subscription.key === getSubscriptionKey(environmentId)) {
        continue
      }
      subscription.unsubscribe()
      subscriptions.delete(environmentId)
    }

    for (const environmentId of desiredIds) {
      const subscriptionKey = getSubscriptionKey(environmentId)
      const pendingSubscription = pending.get(environmentId)
      if (pendingSubscription && pendingSubscription.key !== subscriptionKey) {
        pending.delete(environmentId)
      }
      if (
        subscriptions.get(environmentId)?.key === subscriptionKey ||
        pending.get(environmentId)?.key === subscriptionKey
      ) {
        continue
      }
      clearRetryTimer(environmentId)
      const subscribeGeneration = generation
      const pendingSubscriptionToken = { key: subscriptionKey, generation: subscribeGeneration }
      pending.set(environmentId, pendingSubscriptionToken)
      void deps
        .subscribe(
          environmentId,
          (event) => deps.onEvent(environmentId, event),
          (error) => {
            console.warn('[runtime-client-events] subscription error:', error)
          }
        )
        .then((subscription) => {
          const isCurrentPending = pending.get(environmentId) === pendingSubscriptionToken
          if (isCurrentPending) {
            pending.delete(environmentId)
          }
          if (
            !isCurrentPending ||
            subscribeGeneration !== generation ||
            !deps.getDesiredEnvironmentIds().includes(environmentId) ||
            getSubscriptionKey(environmentId) !== subscriptionKey
          ) {
            subscription.unsubscribe()
            return
          }
          // Why: a concurrent subscribe for this environment already won the
          // overwrite-orphan race. Keep the existing subscription and unsubscribe
          // this duplicate — overwriting would lose the existing unsubscribe and
          // leak its preload handle forever.
          if (subscriptions.get(environmentId)?.key === subscriptionKey) {
            subscription.unsubscribe()
            return
          }
          consecutiveFailures.delete(environmentId)
          subscriptions.set(environmentId, {
            key: subscriptionKey,
            unsubscribe: subscription.unsubscribe
          })
        })
        .catch((error) => {
          const isCurrentPending = pending.get(environmentId) === pendingSubscriptionToken
          if (isCurrentPending) {
            pending.delete(environmentId)
          }
          if (
            isCurrentPending &&
            subscribeGeneration === generation &&
            getSubscriptionKey(environmentId) === subscriptionKey
          ) {
            console.warn('[runtime-client-events] failed to subscribe:', error)
            // Why: only track a failure when we will actually retry this env.
            // A failure that lands after the env left the desired set must not
            // leave a stale count that makes its first retry after re-entry skip
            // the base delay.
            if (deps.getDesiredEnvironmentIds().includes(environmentId)) {
              const failure = consecutiveFailures.get(environmentId)
              consecutiveFailures.set(environmentId, {
                key: subscriptionKey,
                count: failure?.key === subscriptionKey ? failure.count + 1 : 1
              })
              scheduleRetry(environmentId, subscriptionKey, subscribeGeneration)
            } else {
              consecutiveFailures.delete(environmentId)
            }
          }
        })
    }

    for (const [environmentId, pendingSubscription] of pending) {
      if (
        desiredIds.has(environmentId) &&
        pendingSubscription.key === getSubscriptionKey(environmentId)
      ) {
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
