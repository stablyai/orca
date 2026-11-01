import { useState } from 'react'
import {
  usePluginDeclarativeActTarget,
  type PluginDeclarativeDrawnProps
} from './plugin-declarative-act-targets'

type HostValueState<T> = {
  local: T
  /** The guest's `value` and the edit it acknowledged, as last rendered. */
  remote: T | undefined
  acked: number
  /** The newest edit id sent for this control. */
  sent: number
}

/**
 * Value of a control the host owns while the person edits. Each edit goes to the guest with an id,
 * and each render tags the control with the newest edit the guest had processed. A render that has
 * seen every edit is the guest's word, including a reset to the same value it showed before; one
 * that lags the person's typing is an echo and leaves the text alone.
 */
export function usePluginDeclarativeHostValue<T>(options: {
  value: T | undefined
  defaultValue: T | undefined
  fallback: T
  /** The newest edit id the guest had processed when it rendered this control. */
  acked: number | undefined
  callback: string | undefined
  send: (callback: string, value: T, edit: number) => void
  /** The drawn node's props, so `orca plugin shot --act` can edit this control as a person would. */
  actTarget?: PluginDeclarativeDrawnProps
}): { value: T; change: (next: T) => void; readOnly: boolean } {
  const { value, callback, send } = options
  const acked = options.acked ?? 0
  const [state, setState] = useState<HostValueState<T>>(() => ({
    local: value ?? options.defaultValue ?? options.fallback,
    remote: value,
    acked,
    sent: 0
  }))
  let current = state
  if (!Object.is(state.remote, value) || state.acked !== acked) {
    const caughtUp = acked >= state.sent
    current = {
      ...state,
      remote: value,
      acked,
      local: value !== undefined && caughtUp ? value : state.local
    }
    setState(current)
  }
  const result = {
    value: current.local,
    // A controlled value with no handler is the guest's to set: the person cannot edit it.
    readOnly: value !== undefined && callback === undefined,
    change: (next: T) => {
      // Discrete input events re-render synchronously, so `current` is fresh for each edit.
      const edit = current.sent + 1
      setState((previous) => ({ ...previous, local: next, sent: Math.max(previous.sent, edit) }))
      if (callback) {
        send(callback, next, edit)
      }
    }
  }
  usePluginDeclarativeActTarget(options.actTarget, options.fallback, result)
  return result
}
