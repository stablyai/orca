import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type {
  CloudWorkspace,
  CloudWorkspaceListQuery,
  CloudWorkspaceRoutineRuns
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { availabilityRetryDelay } from '@/lib/availability-retry'
import { installWindowVisibilityTimeoutPoller } from '@/lib/window-activity/window-visibility-timeout-poller'
import { rememberCloudWorkspaces } from './cloud-workspace-identity'

/** Presence is live; the list re-reads on this beat while visible (and on focus). */
const POLL_MS = 8_000

export type CloudWorkspacesState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'error'; key: string; error: string; reason?: string }
  | {
      status: 'ready'
      key: string
      workspaces: CloudWorkspace[]
      /** What the Routine runs switch hides; absent from older control planes. */
      routineRuns?: CloudWorkspaceRoutineRuns
    }

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

let failedProbes = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

export function cloudWorkspacesAvailable(): Promise<boolean> {
  availability ??= (window.api?.cloudWorkspaces?.available() ?? Promise.resolve(false)).then(
    (value) => {
      failedProbes = 0
      setAvailable(value)
      return value
    },
    () => {
      // A failed probe is not an answer: forget it and ask again with capped backoff, so one
      // transient error doesn't hide Orca Cloud until restart. Stop while nobody is listening;
      // the next subscriber asks again.
      availability = null
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null
          if (availabilityListeners.size > 0) {
            void cloudWorkspacesAvailable()
          }
        }, availabilityRetryDelay(failedProbes++))
      }
      return false
    }
  )
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

/**
 * `account` is the signed-in `${userId}:${activeOrgId}`: it is part of the read's key, so a team
 * switch re-reads at once and a list read for the previous team is never shown or kept.
 */
function accountOf(key: string): string {
  const parsed: { account: string } = JSON.parse(key)
  return parsed.account
}

export function useCloudWorkspaces(
  query: CloudWorkspaceListQuery,
  enabled: boolean,
  account: string
) {
  const [state, setState] = useState<CloudWorkspacesState>({ status: 'loading' })
  const [reading, setReading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const key = JSON.stringify({ account, query })
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
      const parsed: { query: CloudWorkspaceListQuery } = JSON.parse(key)
      const listQuery = parsed.query
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
        rememberCloudWorkspaces(result.value)
        setState({
          status: 'ready',
          key,
          workspaces: result.value,
          routineRuns: result.routineRuns
        })
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
  // One read for another team is not shown at all: those are not this team's workspaces.
  const settled = state.status === 'ready' || state.status === 'error'
  const otherAccount = settled && accountOf(state.key) !== account
  const shown: CloudWorkspacesState = otherAccount ? { status: 'loading' } : state
  const stale = settled && !otherAccount && state.key !== key
  return { state: shown, stale, reading: reading && enabled, refresh, replace }
}
