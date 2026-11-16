import type { AgentLeaseExpiryProvider } from '../../leases/agent-lease-expiry-timers'
import { settleDroidLeaseExpiry } from './droid-events'
import { droidPaneSessions } from './droid-sessions'
import {
  droidBackgroundChildLeaseDeadline,
  DROID_BACKGROUND_CHILD_LEASE_MS
} from './droid-session-status'

export const DROID_BACKGROUND_CHILD_LEASE_PROVIDER: AgentLeaseExpiryProvider = {
  lease(state, paneKey) {
    const row = state.lastStatusByPaneKey.get(paneKey)
    if (
      row?.payload.agentType !== 'droid' ||
      row.agentPresence?.ended ||
      row.connectionId !== null
    ) {
      return undefined
    }
    const sessions = droidPaneSessions(state, paneKey)
    const deadline = sessions && droidBackgroundChildLeaseDeadline(sessions)
    return deadline === undefined
      ? undefined
      : { deadline, maxDelayMs: DROID_BACKGROUND_CHILD_LEASE_MS }
  },
  settle(state, paneKey, row) {
    const payload = settleDroidLeaseExpiry(state, paneKey)
    return payload
      ? { ...row, hasExplicitPrompt: undefined, hookEventName: undefined, payload }
      : null
  }
}
