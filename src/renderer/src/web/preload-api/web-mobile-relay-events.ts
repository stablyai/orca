import type { MobileRelayStatusDetail } from '../../../../shared/remote-runtime/relay/mobile-relay-status'
import { subscribeRuntimeClientEvents } from '../../runtime/rpc/subscriptions/runtime-client-events'
import { requireActiveEnvironmentOrNull } from '../runtime/client/web-runtime-session'

const listeners = new Set<(detail: MobileRelayStatusDetail) => void>()
let subscription: { unsubscribe: () => void } | null = null
let subscriptionPromise: Promise<void> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

function scheduleRetry(): void {
  if (retryTimer || listeners.size === 0) {
    return
  }
  retryTimer = setTimeout(() => {
    retryTimer = null
    ensureSubscription()
  }, 500)
}

function ensureSubscription(): void {
  if (subscription || subscriptionPromise || listeners.size === 0) {
    return
  }
  const environment = requireActiveEnvironmentOrNull()
  if (!environment) {
    return
  }
  subscriptionPromise = subscribeRuntimeClientEvents(
    environment.id,
    (event) => {
      const raw = event as unknown as
        | ({ type: 'mobileRelayStatusChanged' } & MobileRelayStatusDetail)
        | { type: string }
      if (raw.type !== 'mobileRelayStatusChanged') {
        return
      }
      const detail = raw as { type: 'mobileRelayStatusChanged' } & MobileRelayStatusDetail
      for (const listener of listeners) {
        listener({ status: detail.status, cellUrl: detail.cellUrl })
      }
    },
    () => scheduleRetry()
  )
    .then((next) => {
      subscriptionPromise = null
      if (listeners.size === 0) {
        next.unsubscribe()
        return
      }
      subscription = next
    })
    .catch(() => {
      subscriptionPromise = null
      scheduleRetry()
    })
}

function releaseIfUnused(): void {
  if (listeners.size > 0) {
    return
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  subscription?.unsubscribe()
  subscription = null
}

export function onMobileRelayStatusChanged(
  listener: (detail: MobileRelayStatusDetail) => void
): () => void {
  listeners.add(listener)
  ensureSubscription()
  return () => {
    listeners.delete(listener)
    releaseIfUnused()
  }
}
