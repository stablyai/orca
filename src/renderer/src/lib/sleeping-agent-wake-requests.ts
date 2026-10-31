import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { markSleepingAgentWakeRequest } from './sleeping-agent-wake-request-registry'

export {
  hasSleepingAgentWakeRequest,
  takeSleepingAgentWakeRequest
} from './sleeping-agent-wake-request-registry'

export function getSleepingRecordTabId(record: SleepingAgentSessionRecord): string | null {
  return (
    record.tabId ??
    parsePaneKey(record.paneKey)?.tabId ??
    parseLegacyNumericPaneKey(record.paneKey)?.tabId ??
    null
  )
}

/** Asks the named tabs' sleeping agents to start when their panes mount hidden. */
export function requestSleepingAgentWakeOnMount(
  worktreeId: string,
  tabIds: readonly string[]
): void {
  const wanted = new Set(tabIds)
  for (const record of Object.values(useAppStore.getState().sleepingAgentSessionsByPaneKey)) {
    // Explicit sleep stays asleep until its own tab opens; a sibling record's targeted wake must not
    // wake it just because the two share a tab (#11598).
    if (record.restoreOnTabOpenOnly === true) {
      continue
    }
    const tabId = getSleepingRecordTabId(record)
    if (record.worktreeId === worktreeId && tabId !== null && wanted.has(tabId)) {
      markSleepingAgentWakeRequest(record)
    }
  }
}
