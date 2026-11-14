import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'

export type RuntimeClientEventSubscriptionHandle = {
  unsubscribe: () => void
}

export type RuntimeClientEventsSyncDeps = {
  /** Current desired hosts. Membership and key changes must synchronously call sync;
   *  retries and settlements use the ownership that reconciliation established. */
  getDesiredEnvironmentIds: () => string[]
  /** Changes when an environment's transport generation requires a fresh subscription. */
  getSubscriptionKey?: (environmentId: string) => string
  subscribe: (
    environmentId: string,
    onEvent: (event: RuntimeClientEvent) => void,
    onError: (error: unknown) => void,
    /** Use for subscription-side recovery that runs before event delivery. */
    isCurrent: () => boolean,
    /** The stream ended (e.g. its host connection was replaced); the owner resubscribes. */
    onClose: () => void
  ) => Promise<RuntimeClientEventSubscriptionHandle>
  onEvent: (environmentId: string, event: RuntimeClientEvent) => void
  /** Base retry delay; doubles per consecutive failure up to retryMaxDelayMs. */
  retryDelayMs?: number
  retryMaxDelayMs?: number
  /** Injectable randomness for deterministic backoff-jitter tests. */
  random?: () => number
}

export type RuntimeClientEventsSync = {
  /** Reconciles desired hosts; recovery ids explicitly wake those hosts before their retry deadline. */
  sync: (recoveryEnvironmentIds?: readonly string[]) => void
  /** Retires all ownership so in-flight subscriptions are released on settlement. */
  stop: () => void
}

const STABLE_STREAM_MS = 30_000

type SubscriptionAttempt = {
  closed: boolean
  unsubscribe?: () => void
  installedAt?: number
}

type EnvironmentSubscription = {
  key: string
  attempt?: SubscriptionAttempt
  failures: number
  retryTimer?: ReturnType<typeof setTimeout>
}

export function createRuntimeClientEventsSync(
  deps: RuntimeClientEventsSyncDeps
): RuntimeClientEventsSync {
  const environments = new Map<string, EnvironmentSubscription>()
  const retryDelayMs = deps.retryDelayMs ?? 1_000
  const retryMaxDelayMs = deps.retryMaxDelayMs ?? 30_000
  const random = deps.random ?? Math.random
  const getSubscriptionKey = deps.getSubscriptionKey ?? ((environmentId: string) => environmentId)
  let syncInvocation = 0

  const clearRetry = (entry: EnvironmentSubscription): void => {
    if (entry.retryTimer !== undefined) {
      clearTimeout(entry.retryTimer)
      entry.retryTimer = undefined
    }
  }

  const retire = (entry: EnvironmentSubscription): void => {
    clearRetry(entry)
    const attempt = entry.attempt
    entry.attempt = undefined
    attempt?.unsubscribe?.()
  }

  const scheduleRetry = (environmentId: string, entry: EnvironmentSubscription): void => {
    if (environments.get(environmentId) !== entry || entry.retryTimer !== undefined) {
      return
    }
    const capped = Math.min(retryDelayMs * 2 ** Math.max(0, entry.failures - 1), retryMaxDelayMs)
    entry.retryTimer = setTimeout(
      () => {
        entry.retryTimer = undefined
        if (environments.get(environmentId) === entry) {
          startAttempt(environmentId, entry)
        }
      },
      capped * (0.5 + random() * 0.5)
    )
  }

  const startAttempt = (environmentId: string, entry: EnvironmentSubscription): void => {
    if (environments.get(environmentId) !== entry || entry.attempt) {
      return
    }
    clearRetry(entry)
    const attempt: SubscriptionAttempt = { closed: false }
    entry.attempt = attempt
    const ownsAttempt = (): boolean =>
      environments.get(environmentId) === entry && entry.attempt === attempt
    const isCurrent = (): boolean => ownsAttempt() && !attempt.closed
    void deps
      .subscribe(
        environmentId,
        (event) => {
          if (isCurrent()) {
            deps.onEvent(environmentId, event)
          }
        },
        (error) => console.warn('[runtime-client-events] subscription error:', error),
        isCurrent,
        () => {
          attempt.closed = true
          if (!ownsAttempt() || attempt.installedAt === undefined) {
            return
          }
          entry.attempt = undefined
          if (Date.now() - attempt.installedAt >= STABLE_STREAM_MS) {
            entry.failures = 0
          }
          entry.failures += 1
          scheduleRetry(environmentId, entry)
        }
      )
      .then((subscription) => {
        if (!ownsAttempt()) {
          subscription.unsubscribe()
          return
        }
        if (attempt.closed) {
          entry.attempt = undefined
          subscription.unsubscribe()
          entry.failures += 1
          scheduleRetry(environmentId, entry)
          return
        }
        attempt.unsubscribe = subscription.unsubscribe
        attempt.installedAt = Date.now()
      })
      .catch((error) => {
        if (ownsAttempt()) {
          entry.attempt = undefined
          console.warn('[runtime-client-events] failed to subscribe:', error)
          entry.failures += 1
          scheduleRetry(environmentId, entry)
        }
      })
  }

  const sync = (recoveryEnvironmentIds: readonly string[] = []): void => {
    const invocation = ++syncInvocation
    const desiredIds = new Set(deps.getDesiredEnvironmentIds())
    for (const [environmentId, entry] of environments) {
      if (invocation !== syncInvocation) {
        return
      }
      if (desiredIds.has(environmentId) && entry.key === getSubscriptionKey(environmentId)) {
        continue
      }
      environments.delete(environmentId)
      retire(entry)
    }
    const recoveryIds = new Set(recoveryEnvironmentIds)
    for (const environmentId of desiredIds) {
      if (invocation !== syncInvocation) {
        return
      }
      let entry = environments.get(environmentId)
      if (!entry) {
        entry = { key: getSubscriptionKey(environmentId), failures: 0 }
        environments.set(environmentId, entry)
      }
      if (entry.retryTimer === undefined || recoveryIds.has(environmentId)) {
        startAttempt(environmentId, entry)
      }
    }
  }

  const stop = (): void => {
    syncInvocation += 1
    const stopped = [...environments.values()]
    environments.clear()
    for (const entry of stopped) {
      retire(entry)
    }
  }

  return { sync, stop }
}
