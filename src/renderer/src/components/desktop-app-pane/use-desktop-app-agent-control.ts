import { useCallback, useEffect, useReducer, useRef } from 'react'
import { activityTargetsPane, type DesktopAppPaneTarget } from './desktop-app-agent-activity-match'
import {
  AGENT_CONTROL_IDLE_MS,
  INITIAL_AGENT_CONTROL_STATE,
  reduceAgentControl,
  requestAgentAllow,
  requestAgentStop,
  type DesktopAppAgentControlState
} from './desktop-app-agent-control-state'

export type DesktopAppAgentControl = DesktopAppAgentControlState & {
  stopAgent: () => void
  allowAgent: () => void
}

/** Follows the computer-use actions agents run against this pane's app (border, cursor, stop). */
export function useDesktopAppAgentControl(
  target: DesktopAppPaneTarget | null
): DesktopAppAgentControl {
  const [state, dispatch] = useReducer(reduceAgentControl, INITIAL_AGENT_CONTROL_STATE)
  const windowId = target?.windowId ?? null
  const pid = target?.pid ?? null
  const appName = target?.appName ?? ''
  const bundleId = target?.bundleId ?? null
  // Bumped on every target change so a late Stop/Allow failure only rolls back its own target.
  const targetVersion = useRef(0)

  useEffect(() => {
    targetVersion.current += 1
    dispatch({ type: 'reset' })
    const api = window.api?.desktopApp
    if (!api || windowId === null || pid === null) {
      return
    }
    const paneTarget = { windowId, pid, appName, bundleId }
    let disposed = false
    // Why: main keeps blocking the pid across a remount or window-list blip; show Allow again.
    void api
      .isAgentBlocked({ pid })
      .then((blocked) => {
        if (blocked && !disposed) {
          dispatch({ type: 'hydrateStopped' })
        }
      })
      .catch((error: unknown) => console.warn('[desktop-app] isAgentBlocked failed:', error))
    // Why: every activity reaches the reducer so an `end` that resolved elsewhere still closes
    // the action its matching `start` opened here.
    const unsubscribe = api.onAgentActivity((activity) => {
      dispatch({
        type: 'activity',
        activity,
        targetsPane: activityTargetsPane(activity, paneTarget)
      })
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [windowId, pid, appName, bundleId])

  useEffect(() => {
    if (!state.controlling) {
      return
    }
    const timer = setInterval(
      () => dispatch({ type: 'idle', now: Date.now() }),
      AGENT_CONTROL_IDLE_MS / 4
    )
    return () => clearInterval(timer)
  }, [state.controlling])

  const stopAgent = useCallback(() => {
    if (pid === null) {
      return
    }
    const api = window.api?.desktopApp
    const version = targetVersion.current
    void requestAgentStop(
      dispatch,
      api && (() => api.stopAgent({ pid, appName, bundleId })),
      () => targetVersion.current === version
    )
  }, [pid, appName, bundleId])

  const allowAgent = useCallback(() => {
    if (pid === null) {
      return
    }
    const api = window.api?.desktopApp
    const version = targetVersion.current
    void requestAgentAllow(
      dispatch,
      api && (() => api.allowAgent({ pid })),
      () => targetVersion.current === version
    )
  }, [pid])

  return { ...state, stopAgent, allowAgent }
}
