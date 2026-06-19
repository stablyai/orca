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
  let generation = 0

  const stop = (): void => {
    generation += 1
    for (const unsubscribe of subscriptions.values()) {
      unsubscribe()
    }
    subscriptions.clear()
    pending.clear()
  }

  const sync = (): void => {
    const desiredIds = new Set(deps.getDesiredEnvironmentIds())

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
          subscriptions.set(environmentId, subscription.unsubscribe)
        })
        .catch((error) => {
          pending.delete(environmentId)
          if (subscribeGeneration === generation) {
            console.warn('[runtime-client-events] failed to subscribe:', error)
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
