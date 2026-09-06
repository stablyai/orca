import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { refreshLocalRuntimeCapabilities } from '../local-runtime-capabilities'
import {
  isCurrentLocalStructuredSessionGeneration,
  localStructuredSessionGeneration
} from './inventory-generation-fence'
import {
  refreshLocalStructuredSessionTabs,
  restoreLocalStructuredSessionTabsOnce
} from './inventory-refresh'
import { applyStructuredSessionTabSnapshots } from './snapshot-apply'

type SessionTabsEvent =
  | (RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' })
  | { type: 'snapshots'; snapshots: RuntimeMobileSessionTabsResult[] }
  | { type: 'end' }

export async function startLocalStructuredSessionTabsSync(args: {
  isDisposed: () => boolean
  setUnsubscribe: (unsubscribe: () => void) => void
}): Promise<void> {
  const syncGeneration = localStructuredSessionGeneration()
  const isCurrent = (): boolean =>
    !args.isDisposed() && isCurrentLocalStructuredSessionGeneration(syncGeneration)
  const capabilities = await refreshLocalRuntimeCapabilities()
  if (!isCurrent()) {
    return
  }
  const supported = capabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
  await restoreLocalStructuredSessionTabsOnce(syncGeneration)
  if (!isCurrent()) {
    return
  }
  if (!supported) {
    return
  }
  let subscriptionGeneration = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  let activeHandle: { unsubscribe: () => void } | null = null
  const scheduleSubscribeRetry = (): void => {
    if (!isCurrent() || reconnectTimer !== null) {
      return
    }
    const reconnectDelay = Math.min(250 * 2 ** reconnectAttempt, 5000)
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void refreshLocalStructuredSessionTabs(syncGeneration)
        .catch((error) => console.warn('[structured-session-tabs] resync failed', error))
        .finally(() => {
          if (isCurrent()) {
            void subscribeCurrent().catch((error) => {
              console.warn('[structured-session-tabs] resubscribe failed', error)
              scheduleSubscribeRetry()
            })
          }
        })
    }, reconnectDelay)
  }
  const subscribeCurrent = async (): Promise<void> => {
    if (!isCurrent()) {
      return
    }
    const generation = ++subscriptionGeneration
    let handle: { unsubscribe: () => void } | null = null
    handle = await window.api.runtime.subscribe(
      { method: 'session.tabs.subscribeAll', params: {} },
      (response) => {
        if (!isCurrent() || generation !== subscriptionGeneration) {
          return
        }
        if (!response.ok) {
          // A streaming RPC can terminate with an error response before its
          // handle resolves; fence that generation and retry the subscription.
          subscriptionGeneration += 1
          handle?.unsubscribe()
          if (activeHandle === handle) {
            activeHandle = null
          }
          scheduleSubscribeRetry()
          return
        }
        const event = response.result as SessionTabsEvent
        if (event.type === 'snapshots') {
          applyStructuredSessionTabSnapshots(event.snapshots)
        } else if (event.type === 'snapshot' || event.type === 'updated') {
          applyStructuredSessionTabSnapshots([event])
        } else if (event.type === 'end' && generation === subscriptionGeneration) {
          // Reattach with one refresh so a runtime-restart boundary cannot strand stale tabs.
          subscriptionGeneration += 1
          handle?.unsubscribe()
          if (activeHandle === handle) {
            activeHandle = null
          }
          if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer)
          }
          scheduleSubscribeRetry()
        }
      }
    )
    if (!isCurrent() || generation !== subscriptionGeneration) {
      handle.unsubscribe()
    } else {
      activeHandle = handle
    }
  }
  args.setUnsubscribe(() => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    activeHandle?.unsubscribe()
    activeHandle = null
  })
  void subscribeCurrent().catch((error) => {
    console.warn('[structured-session-tabs] subscribe failed', error)
    scheduleSubscribeRetry()
  })
}
