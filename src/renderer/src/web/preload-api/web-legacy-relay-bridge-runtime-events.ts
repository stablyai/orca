import type { LegacyRelayBridgedPane } from '../../../../shared/remote-runtime/relay/legacy-relay-bridge-contract'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  getClientForEnvironment,
  requireActiveEnvironmentOrNull
} from '../runtime/client/web-runtime-session'

type LegacyRelayBridgedPanesChanged = {
  type: 'legacyRelayBridgedPanesChanged'
  panes: LegacyRelayBridgedPane[]
}
type LegacyRelayBridgeStreamEvent =
  | LegacyRelayBridgedPanesChanged
  | { type: 'legacyRelayBridgedPaneData'; ptyId: string; data: string }
  | { type: 'legacyRelayBridgedPaneReplay'; ptyId: string; replay: string }
  | { type: 'legacyRelayBridgedPaneExit'; ptyId: string; code: number }

const panesListeners = new Set<(panes: LegacyRelayBridgedPanesChanged['panes']) => void>()
const dataListeners = new Set<(event: { ptyId: string; data: string }) => void>()
const replayListeners = new Set<(event: { ptyId: string; replay: string }) => void>()
const exitListeners = new Set<(event: { ptyId: string; code: number }) => void>()
let eventSubscription: { unsubscribe: () => void; abort: AbortController } | null = null
let eventSubscriptionPromise: Promise<void> | null = null
let eventRetryTimer: ReturnType<typeof setTimeout> | null = null

function hasListeners(): boolean {
  return (
    panesListeners.size > 0 ||
    dataListeners.size > 0 ||
    replayListeners.size > 0 ||
    exitListeners.size > 0
  )
}

function deliverEvent(response: RuntimeRpcResponse<unknown>): void {
  if (!response.ok) {
    scheduleSubscription()
    return
  }
  const message = response.result as LegacyRelayBridgeStreamEvent
  if (message.type === 'legacyRelayBridgedPanesChanged') {
    for (const listener of panesListeners) {
      listener(message.panes)
    }
  } else if (message.type === 'legacyRelayBridgedPaneData') {
    for (const listener of dataListeners) {
      listener({ ptyId: message.ptyId, data: message.data })
    }
  } else if (message.type === 'legacyRelayBridgedPaneReplay') {
    for (const listener of replayListeners) {
      listener({ ptyId: message.ptyId, replay: message.replay })
    }
  } else if (message.type === 'legacyRelayBridgedPaneExit') {
    for (const listener of exitListeners) {
      listener({ ptyId: message.ptyId, code: message.code })
    }
  }
}

function scheduleSubscription(): void {
  if (eventRetryTimer || !hasListeners()) {
    return
  }
  eventRetryTimer = setTimeout(() => {
    eventRetryTimer = null
    ensureSubscription()
  }, 500)
}

function ensureSubscription(): void {
  if (eventSubscription || eventSubscriptionPromise || !hasListeners()) {
    return
  }
  const environment = requireActiveEnvironmentOrNull()
  if (!environment) {
    return
  }
  const abort = new AbortController()
  eventSubscriptionPromise = getClientForEnvironment(environment)
    .subscribe(
      'runtime.clientEvents.subscribe',
      null,
      {
        onResponse: deliverEvent,
        onError: () => scheduleSubscription(),
        onClose: () => {
          eventSubscription = null
          scheduleSubscription()
        }
      },
      { signal: abort.signal }
    )
    .then((subscription) => {
      eventSubscriptionPromise = null
      if (abort.signal.aborted || !hasListeners()) {
        subscription.unsubscribe()
        return
      }
      eventSubscription = { unsubscribe: subscription.unsubscribe, abort }
    })
    .catch(() => {
      eventSubscriptionPromise = null
      scheduleSubscription()
    })
}

function releaseIfUnused(): void {
  if (hasListeners()) {
    return
  }
  if (eventRetryTimer) {
    clearTimeout(eventRetryTimer)
    eventRetryTimer = null
  }
  eventSubscription?.abort.abort()
  eventSubscription?.unsubscribe()
  eventSubscription = null
}

function subscribe<T>(
  listeners: Set<(event: T) => void>,
  listener: (event: T) => void
): () => void {
  listeners.add(listener)
  ensureSubscription()
  return () => {
    listeners.delete(listener)
    releaseIfUnused()
  }
}

export function onLegacyRelayBridgedPanes(
  listener: (panes: LegacyRelayBridgedPanesChanged['panes']) => void
): () => void {
  return subscribe(panesListeners, listener)
}

export function onLegacyRelayBridgedPaneData(
  listener: (event: { ptyId: string; data: string }) => void
): () => void {
  return subscribe(dataListeners, listener)
}

export function onLegacyRelayBridgedPaneReplay(
  listener: (event: { ptyId: string; replay: string }) => void
): () => void {
  return subscribe(replayListeners, listener)
}

export function onLegacyRelayBridgedPaneExit(
  listener: (event: { ptyId: string; code: number }) => void
): () => void {
  return subscribe(exitListeners, listener)
}
