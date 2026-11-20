import type { WslHostStatus } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { subscribeRuntimeClientEvents } from '../../runtime/rpc/subscriptions/runtime-client-events'
import { requireActiveEnvironmentOrNull } from '../runtime/client/web-runtime-session'

const listeners = new Set<(status: WslHostStatus) => void>()
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
        | { type: 'wslHostStatusChanged'; status: WslHostStatus }
        | { type: string }
      if (raw.type !== 'wslHostStatusChanged') {
        return
      }
      const change = raw as { type: 'wslHostStatusChanged'; status: WslHostStatus }
      for (const listener of listeners) {
        listener(change.status)
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

export function onWslHostStatusChanged(listener: (status: WslHostStatus) => void): () => void {
  listeners.add(listener)
  ensureSubscription()
  return () => {
    listeners.delete(listener)
    releaseIfUnused()
  }
}
