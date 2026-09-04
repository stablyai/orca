import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PlaneConnectionStatus } from '../../../shared/plane-types'
import { planeStatus } from '@/runtime/runtime-plane-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

const DISCONNECTED: PlaneConnectionStatus = { connected: false, viewer: null }

type PlaneConnectionState = {
  status: PlaneConnectionStatus
  checking: boolean
  error: string | null
}

type PlaneConnectionSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

/**
 * One shared connection state for every consumer.
 *
 * Why not per-hook state: the Tasks settings pane, the provider readiness hook,
 * the integration card and the Tasks surface all ask about the same connection.
 * With independent state, connecting from one of them left the others reporting
 * "Connect required" until their own effect happened to run again.
 */
let state: PlaneConnectionState = { status: DISCONNECTED, checking: true, error: null }
const listeners = new Set<() => void>()
// Keyed by environment: sharing one in-flight promise across environments
// returned the previous host's status for the new one.
let inFlight: { key: string; promise: Promise<void> } | null = null
// Only the newest request may commit; an older one resolving later must not
// overwrite it.
let generation = 0

function setState(next: PlaneConnectionState): void {
  state = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function refreshPlaneConnection(settings: PlaneConnectionSettings): Promise<void> {
  const key = settings?.activeRuntimeEnvironmentId ?? ''
  if (inFlight?.key === key) {
    return inFlight.promise
  }
  const current = ++generation
  setState({ ...state, checking: true, error: null })
  const promise = runStatusCheck(settings, current)
  inFlight = { key, promise }
  return promise
}

async function runStatusCheck(settings: PlaneConnectionSettings, current: number): Promise<void> {
  try {
    const status = await planeStatus(settings)
    if (current === generation) {
      setState({ status, checking: false, error: null })
    }
  } catch (cause) {
    if (current === generation) {
      setState({
        status: DISCONNECTED,
        checking: false,
        error:
          cause instanceof Error
            ? cause.message
            : translate('auto.hooks.usePlaneConnection.failed', 'Unable to check Plane access')
      })
    }
  } finally {
    // A newer request already owns inFlight; leave it alone.
    if (current === generation) {
      inFlight = null
    }
  }
}

/** Current shared snapshot, for callers outside React and for assertions. */
export function getPlaneConnectionSnapshot(): PlaneConnectionState {
  return state
}

/** Test seam: drops the shared state so suites cannot leak into each other. */
export function resetPlaneConnectionState(): void {
  state = { status: DISCONNECTED, checking: true, error: null }
  inFlight = null
  generation = 0
  listeners.clear()
}

export function usePlaneConnection(): PlaneConnectionState & { refresh: () => Promise<void> } {
  // Subscribing to the whole settings object re-fired this for every unrelated change.
  const activeRuntimeEnvironmentId = useAppStore(
    (appState) => appState.settings?.activeRuntimeEnvironmentId
  )
  const snapshot = useSyncExternalStore(subscribe, () => state)
  const refresh = useCallback(
    () => refreshPlaneConnection({ activeRuntimeEnvironmentId }),
    [activeRuntimeEnvironmentId]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { ...snapshot, refresh }
}
