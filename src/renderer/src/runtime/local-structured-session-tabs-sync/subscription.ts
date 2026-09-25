import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  refreshLocalRuntimeCapabilities
} from '../local-runtime-capabilities'
import {
  refreshLocalStructuredSessionTabs,
  restoreLocalStructuredSessionTabsOnce
} from './inventory-refresh'
import { scheduleRetiredEpochRepair } from './retired-epoch-repair'
import {
  applyStructuredSessionTabSnapshots,
  type StructuredSessionSnapshotApplyOptions
} from './snapshot-apply'

// The refresh is supplied here rather than imported by the repair lane, so nothing the snapshot
// apply depends on depends back on it.
const REPAIR_DROPPED_EPOCHS: StructuredSessionSnapshotApplyOptions = {
  onRetiredEpochDrop: (worktreeId, publicationEpoch) =>
    scheduleRetiredEpochRepair(worktreeId, publicationEpoch, () =>
      refreshLocalStructuredSessionTabs({ authoritative: true })
    )
}

/** `null` when the probe failed: that is not evidence the host lacks the surface. */
async function probeStructuredSessionSurface(): Promise<boolean | null> {
  await refreshLocalRuntimeCapabilities()
  return (
    readLocalRuntimeCapabilitiesOrUnknown()?.includes(
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ) ?? null
  )
}

type SessionTabsEvent =
  | (RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' })
  | { type: 'snapshots'; snapshots: RuntimeMobileSessionTabsResult[]; authoritative?: boolean }
  | { type: 'end' }

/** Resolves true once the subscription (or its retry) owns the mirror; false when disposed or the
 *  host answered without the structured surface. */
export async function startLocalStructuredSessionTabsSync(args: {
  isDisposed: () => boolean
  setUnsubscribe: (unsubscribe: () => void) => void
}): Promise<boolean> {
  const isCurrent = (): boolean => !args.isDisposed()
  let supported = await probeStructuredSessionSurface()
  if (!isCurrent()) {
    return false
  }
  await restoreLocalStructuredSessionTabsOnce()
  if (!isCurrent() || supported === false) {
    return false
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
      void refreshLocalStructuredSessionTabs()
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
    // An unknown answer is asked again on the subscribe backoff rather than read as unsupported.
    supported ??= await probeStructuredSessionSurface()
    if (supported === null) {
      throw new Error('structured_session_capability_unknown')
    }
    if (!supported || !isCurrent()) {
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
          applyStructuredSessionTabSnapshots(event.snapshots, undefined, {
            ...REPAIR_DROPPED_EPOCHS,
            authoritative: event.authoritative === true
          })
        } else if (event.type === 'snapshot' || event.type === 'updated') {
          applyStructuredSessionTabSnapshots([event], undefined, REPAIR_DROPPED_EPOCHS)
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
  return true
}
