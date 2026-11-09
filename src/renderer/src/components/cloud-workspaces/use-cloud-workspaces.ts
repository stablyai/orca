import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type {
  CloudWorkspace,
  CloudWorkspaceListQuery
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { installWindowVisibilityTimeoutPoller } from '@/lib/window-visibility-timeout-poller'

/** Presence is live; the list re-reads on this beat while visible (and on focus). */
const POLL_MS = 8_000

export type CloudWorkspacesState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'error'; key: string; error: string; reason?: string }
  | { status: 'ready'; key: string; workspaces: CloudWorkspace[] }

// Whether this build talks to an Orca Cloud control plane at all (cached per session). The value
// is mirrored into a tiny store so surfaces can render nothing until it is known (no flash).
let availability: Promise<boolean> | null = null
let availableValue: boolean | null = null
const availabilityListeners = new Set<() => void>()

function setAvailable(value: boolean): void {
  if (availableValue !== value) {
    availableValue = value
    availabilityListeners.forEach((listener) => listener())
  }
}

export function cloudWorkspacesAvailable(): Promise<boolean> {
  availability ??= (
    window.api.cloudWorkspaces?.available().catch(() => false) ?? Promise.resolve(false)
  ).then((value) => {
    setAvailable(value)
    return value
  })
  return availability
}

/** null until the first availability answer arrives. */
export function useCloudWorkspacesAvailable(): boolean | null {
  return useSyncExternalStore(
    (listener) => {
      availabilityListeners.add(listener)
      void cloudWorkspacesAvailable()
      return () => availabilityListeners.delete(listener)
    },
    () => availableValue
  )
}

export function useCloudWorkspaces(query: CloudWorkspaceListQuery, enabled: boolean) {
  const [state, setState] = useState<CloudWorkspacesState>({ status: 'loading' })
  const [reading, setReading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const key = JSON.stringify(query)
  const keyRef = useRef(key)
  keyRef.current = key
  const refresh = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let disposed = false
    // Set when a read shows there is nothing more to poll for; the poller then stops re-arming.
    let stopped = false
    const load = async (): Promise<void> => {
      if (!(await cloudWorkspacesAvailable())) {
        stopped = true
        if (!disposed) {
          setState({ status: 'unavailable' })
        }
        return
      }
      if (disposed) {
        return
      }
      setReading(true)
      const listQuery: CloudWorkspaceListQuery = JSON.parse(key)
      let result: Awaited<ReturnType<typeof window.api.cloudWorkspaces.list>>
      try {
        result = await window.api.cloudWorkspaces.list(listQuery)
      } finally {
        // Even when the IPC call throws, the refresh spinner must not stay on.
        if (!disposed) {
          setReading(false)
        }
      }
      if (disposed || keyRef.current !== key) {
        stopped = true
        return
      }
      if (result.ok) {
        setState({ status: 'ready', key, workspaces: result.value })
      } else if (result.error === 'not_configured') {
        stopped = true
        setAvailable(false)
        setState({ status: 'unavailable' })
      } else {
        // A transient poll failure keeps the last good list, but only for this same query.
        setState((previous) =>
          previous.status === 'ready' && previous.key === key
            ? previous
            : { status: 'error', key, error: result.error, reason: result.reason }
        )
      }
    }
    // The poller owns the timer and visibility listeners: it re-arms after each read while the
    // window is visible, reads again when it becomes visible, and its disposer clears both.
    const stopPolling = installWindowVisibilityTimeoutPoller({
      run: load,
      getDelayMs: () => (stopped ? null : POLL_MS)
    })
    return () => {
      disposed = true
      stopPolling()
    }
  }, [key, reloadKey, enabled])

  /** Optimistic local edit (visibility, section, archive) until the next read confirms it. */
  const replace = useCallback((next: CloudWorkspace) => {
    setState((previous) =>
      previous.status === 'ready'
        ? { ...previous, workspaces: previous.workspaces.map((w) => (w.id === next.id ? next : w)) }
        : previous
    )
  }, [])

  // A list or error read for an earlier filter is shown dimmed and busy until this one lands.
  const stale = (state.status === 'ready' || state.status === 'error') && state.key !== key
  return { state, stale, reading: reading && enabled, refresh, replace }
}
