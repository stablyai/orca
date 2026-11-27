import type { PtyTransportRecoveryState } from '../../pty-transport-types'

/** A surface's panes on a down server: one still retrying, all stopped, or none in an outage recovery. */
export type RemoteServerPaneRetries = 'retrying' | 'latched' | null

/** Ownership handoffs and SSH sign-in waits explain themselves; a parked retry is stopped like a latched one. */
export function classifyRemoteServerPaneRetries(
  states: readonly (Pick<PtyTransportRecoveryState, 'phase' | 'reason' | 'waiting'> | undefined)[]
): RemoteServerPaneRetries {
  let latched = false
  for (const state of states) {
    if (!state || state.reason === 'ownership' || state.reason === 'ssh-sign-in') {
      continue
    }
    if (state.phase === 'disconnected' || state.waiting) {
      latched = true
    } else if (state.phase === 'recovering' || state.phase === 'backoff') {
      return 'retrying'
    }
  }
  return latched ? 'latched' : null
}
