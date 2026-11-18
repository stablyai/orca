import { useAppStore } from '@/store'
import { withoutMailWake } from '../../../../shared/agent-session/lifecycle/mail-wake-obligation'

/** A main-side consumption or ownership change ends custody even when the pane stays mounted. */
export function reconcileMailWakeCustody(settledIds: readonly string[] = []): void {
  const store = useAppStore.getState()
  const ids = new Set(settledIds)
  for (const record of Object.values(store.sleepingAgentSessionsByPaneKey)) {
    if (record.mailWake && ids.has(record.mailWake.id)) {
      store.rememberSleepingAgentSession(withoutMailWake(record), record)
    }
  }
}
