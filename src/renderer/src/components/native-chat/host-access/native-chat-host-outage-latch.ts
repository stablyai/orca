import { subscribeRuntimeHostConnectionState } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import type { RuntimeHostConnectionState } from '../../../../../shared/remote-runtime/host-status/runtime-host-connection-state'

/** `stopped`: a WSL host's distro stopped; only an explicit Start boots it (E9). */
export type NativeChatHostOutageKind = 'reconnecting' | 'offline' | 'stopped'

export type NativeChatHostOutage = {
  kind: NativeChatHostOutageKind
  environmentId: string
  hostLabel: string
  /** Auth/protocol refusals would also reject reconnection. */
  canReconnect: boolean
}

/** Suppress brief reconnect blips; show offline hosts immediately. */
export const NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS = 2_000

export function nativeChatHostOutageKind(
  state: RuntimeHostConnectionState
): NativeChatHostOutageKind | null {
  // A closed workspace window still answers requests that do not need that window.
  switch (state) {
    case 'connected':
    case 'workspace-window-closed':
      return null
    // These states have no automatic transport recovery.
    case 'disconnected':
      return 'offline'
    // runtime-unavailable also precedes the probe on every recovery.
    case 'checking':
    case 'reconnecting':
    case 'runtime-unavailable':
      return 'reconnecting'
  }
}

type EarnedOutage = { environmentId: string; kind: NativeChatHostOutageKind } | null

export function createNativeChatHostOutageLatch() {
  let earned: EarnedOutage = null
  const listeners = new Set<() => void>()
  const publish = (next: EarnedOutage) => {
    if (earned?.environmentId === next?.environmentId && earned?.kind === next?.kind) {
      return
    }
    earned = next
    for (const listener of listeners) {
      listener()
    }
  }
  return {
    read: () => earned,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    track: (environmentId: string) => {
      let inOutage = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const unsubscribe = subscribeRuntimeHostConnectionState(environmentId, (state) => {
        const kind = nativeChatHostOutageKind(state)
        if (kind === null) {
          inOutage = false
          clearTimeout(timer)
          publish(null)
          return
        }
        if (kind === 'offline') {
          publish({ environmentId, kind: 'offline' })
        }
        if (!inOutage) {
          inOutage = true
          timer = setTimeout(() => {
            if (!earned) {
              publish({ environmentId, kind: 'reconnecting' })
            }
          }, NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS)
        }
      })
      return () => {
        unsubscribe()
        clearTimeout(timer)
        publish(null)
      }
    }
  }
}
