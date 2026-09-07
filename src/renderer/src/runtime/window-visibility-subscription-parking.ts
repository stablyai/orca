import {
  getWindowParkVisible,
  subscribeWindowParkVisibility,
  WINDOW_HIDE_PARK_GRACE_MS
} from '@/lib/window-park-visibility'

// Why: the same app-switch grace every park site uses; the backoff below is what makes this one adaptive.
export const WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS = WINDOW_HIDE_PARK_GRACE_MS
// Why: resuming re-enumerates every host, so repeated short hides must widen the park delay instead of paying that cost each cycle.
export const WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_BACKOFF_LIMIT = 8
export const WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS = 1_000
const WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_MAX_MS = 30_000
const WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_JITTER_MS = 250

export type WindowVisibilitySubscriptionContext = {
  visibilityGeneration: number
}

export type WindowVisibilitySubscriptionSpec = {
  subscribe: (
    isCurrent: () => boolean,
    context: WindowVisibilitySubscriptionContext
  ) => Promise<{ unsubscribe: () => void }>
  onSubscribeError?: (error: unknown) => void
  onUnsubscribeError?: (error: unknown) => void
}

export type WindowVisibilitySubscriptionParkingOptions = {
  getVisibilityResumePriority?: (specIndex: number) => number
  parkDelayMs?: number
  visibilityResumeStaggerMs?: number
  onVisibilityResume?: (args: {
    visibilityGeneration: number
    restartingSpecIndexes: readonly number[]
  }) => void
}

type SubscriptionEntry = {
  desired: boolean
  generation: number
  visibilityGeneration: number
  pending: Promise<void> | null
  retryAttempt: number
  retryTimer: ReturnType<typeof setTimeout> | null
  startTimer: ReturnType<typeof setTimeout> | null
  unsubscribe: (() => void) | null
}

export function installWindowVisibilitySubscriptionParking(
  specs: readonly WindowVisibilitySubscriptionSpec[],
  options: WindowVisibilitySubscriptionParkingOptions = {}
): () => void {
  const parkDelayMs = options.parkDelayMs ?? WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS
  const maxParkDelayMs = parkDelayMs * WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_BACKOFF_LIMIT
  let disposed = false
  let effectiveVisible = getWindowParkVisible()
  let visibilityGeneration = effectiveVisible ? 0 : 1
  let parkTimer: ReturnType<typeof setTimeout> | null = null
  let currentParkDelayMs = parkDelayMs
  let hiddenSinceMs: number | null = null
  const entries: SubscriptionEntry[] = specs.map(() => ({
    desired: false,
    generation: 0,
    visibilityGeneration: 0,
    pending: null,
    retryAttempt: 0,
    retryTimer: null,
    startTimer: null,
    unsubscribe: null
  }))

  const clearRetry = (entry: SubscriptionEntry): void => {
    if (entry.retryTimer !== null) {
      clearTimeout(entry.retryTimer)
      entry.retryTimer = null
    }
  }

  const clearStart = (entry: SubscriptionEntry): void => {
    if (entry.startTimer !== null) {
      clearTimeout(entry.startTimer)
      entry.startTimer = null
    }
  }

  const unsubscribeEntry = (entry: SubscriptionEntry, spec: WindowVisibilitySubscriptionSpec) => {
    const unsubscribe = entry.unsubscribe
    entry.unsubscribe = null
    if (!unsubscribe) {
      return
    }
    try {
      unsubscribe()
    } catch (error) {
      spec.onUnsubscribeError?.(error)
    }
  }

  function scheduleRetry(entry: SubscriptionEntry, spec: WindowVisibilitySubscriptionSpec): void {
    if (disposed || !entry.desired || entry.retryTimer !== null) {
      return
    }
    const exponentialDelay = Math.min(
      WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS * 2 ** Math.min(entry.retryAttempt, 5),
      WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_MAX_MS
    )
    const jitter = Math.floor(Math.random() * WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_JITTER_MS)
    entry.retryAttempt += 1
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null
      startEntry(entry, spec)
    }, exponentialDelay + jitter)
  }

  function startEntry(entry: SubscriptionEntry, spec: WindowVisibilitySubscriptionSpec): void {
    if (
      disposed ||
      !entry.desired ||
      entry.pending ||
      entry.retryTimer !== null ||
      entry.startTimer !== null ||
      entry.unsubscribe
    ) {
      return
    }
    const generation = entry.generation
    const isCurrent = (): boolean => !disposed && entry.desired && entry.generation === generation
    let subscription: Promise<{ unsubscribe: () => void }>
    try {
      subscription = spec.subscribe(isCurrent, {
        visibilityGeneration: entry.visibilityGeneration
      })
    } catch (error) {
      if (isCurrent()) {
        spec.onSubscribeError?.(error)
        scheduleRetry(entry, spec)
      }
      return
    }
    const pending = Promise.resolve(subscription).then(
      (handle) => {
        if (entry.pending !== pending) {
          try {
            handle.unsubscribe()
          } catch (error) {
            spec.onUnsubscribeError?.(error)
          }
          return
        }
        entry.pending = null
        if (isCurrent()) {
          entry.retryAttempt = 0
          entry.unsubscribe = handle.unsubscribe
          return
        }
        try {
          handle.unsubscribe()
        } catch (error) {
          spec.onUnsubscribeError?.(error)
        }
        if (!disposed && entry.desired) {
          startEntry(entry, spec)
        }
      },
      (error) => {
        if (entry.pending !== pending) {
          return
        }
        entry.pending = null
        if (isCurrent()) {
          spec.onSubscribeError?.(error)
          scheduleRetry(entry, spec)
          return
        }
        if (!disposed && entry.desired) {
          startEntry(entry, spec)
        }
      }
    )
    entry.pending = pending
  }

  const startAll = (isVisibilityResume: boolean): void => {
    const restartingSpecIndexes = entries.flatMap((entry, index) => (entry.desired ? [] : [index]))
    if (isVisibilityResume && restartingSpecIndexes.length > 0) {
      options.onVisibilityResume?.({ visibilityGeneration, restartingSpecIndexes })
    }
    for (const index of restartingSpecIndexes) {
      const entry = entries[index]
      entry.visibilityGeneration = visibilityGeneration
      entry.desired = true
    }
    const startOrder = isVisibilityResume
      ? [...restartingSpecIndexes].sort((left, right) => {
          const priority = options.getVisibilityResumePriority
          return (priority?.(left) ?? 0) - (priority?.(right) ?? 0) || left - right
        })
      : restartingSpecIndexes
    const staggerMs = Math.max(0, options.visibilityResumeStaggerMs ?? 0)
    if (!isVisibilityResume || staggerMs === 0) {
      for (const index of startOrder) {
        startEntry(entries[index], specs[index])
      }
      return
    }
    const startNext = (position: number): void => {
      const index = startOrder[position]
      if (index === undefined) {
        return
      }
      const entry = entries[index]
      entry.startTimer = null
      if (disposed || !entry.desired) {
        return
      }
      startEntry(entry, specs[index])
      const nextIndex = startOrder[position + 1]
      if (nextIndex === undefined) {
        return
      }
      const nextEntry = entries[nextIndex]
      nextEntry.startTimer = setTimeout(() => startNext(position + 1), staggerMs)
    }
    startNext(0)
  }
  const stopAll = (): void => {
    entries.forEach((entry, index) => {
      entry.desired = false
      entry.generation += 1
      entry.retryAttempt = 0
      clearStart(entry)
      clearRetry(entry)
      unsubscribeEntry(entry, specs[index])
    })
  }
  const cancelPark = (): void => {
    if (parkTimer !== null) {
      clearTimeout(parkTimer)
      parkTimer = null
    }
  }
  const reconcileVisibility = (): void => {
    if (getWindowParkVisible()) {
      cancelPark()
      const hiddenMs = hiddenSinceMs === null ? null : Date.now() - hiddenSinceMs
      hiddenSinceMs = null
      if (!effectiveVisible) {
        effectiveVisible = true
        if (hiddenMs !== null) {
          // Why: a park that the user undoes quickly costs more than it saves, so back off until one hide outlasts the ceiling.
          currentParkDelayMs =
            hiddenMs >= maxParkDelayMs
              ? parkDelayMs
              : Math.min(currentParkDelayMs * 2, maxParkDelayMs)
        }
        startAll(visibilityGeneration > 0)
      }
      return
    }
    if (!effectiveVisible || parkTimer !== null) {
      return
    }
    hiddenSinceMs = Date.now()
    parkTimer = setTimeout(() => {
      parkTimer = null
      if (getWindowParkVisible()) {
        reconcileVisibility()
        return
      }
      effectiveVisible = false
      visibilityGeneration += 1
      stopAll()
    }, currentParkDelayMs)
  }

  if (effectiveVisible) {
    startAll(false)
  }
  const unsubscribeVisibility = subscribeWindowParkVisibility(reconcileVisibility)

  return () => {
    disposed = true
    cancelPark()
    unsubscribeVisibility()
    effectiveVisible = false
    stopAll()
  }
}
