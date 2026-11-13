import { useAppStore } from '@/store/index'
import { sleepingAgentRecordIndex } from '@/store/terminals/sleeping-agent-record-index'
import {
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../../shared/workspace-layout/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

// Why record identity: a replaced or cleared record drops its request, so a stale ask never wakes a later sleep.
const requestedRecords = new WeakSet<SleepingAgentSessionRecord>()

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
  for (const [, record] of sleepingAgentRecordIndex.entries(
    useAppStore.getState().sleepingAgentSessionsByPaneKey,
    worktreeId
  )) {
    const tabId = getSleepingRecordTabId(record)
    if (record.worktreeId === worktreeId && tabId !== null && wanted.has(tabId)) {
      requestedRecords.add(record)
    }
  }
}

// Why one tab: a pop-out window shows a single tab while that tab's in-window pane stays hidden.
let tabShownOutsidePane: { worktreeId: string; tabId: string } | null = null

/** Marks the tab a pop-out window shows; its hidden pane then starts a sleeping agent as if revealed. */
export function setTabShownOutsidePane(worktreeId: string, tabId: string | null): void {
  tabShownOutsidePane = tabId ? { worktreeId, tabId } : null
}

/** True once for a recorded request, and on every connect while the record's tab is shown outside its pane. */
export function takeSleepingAgentWakeRequest(record: SleepingAgentSessionRecord): boolean {
  if (requestedRecords.delete(record)) {
    return true
  }
  return (
    tabShownOutsidePane !== null &&
    record.worktreeId === tabShownOutsidePane.worktreeId &&
    getSleepingRecordTabId(record) === tabShownOutsidePane.tabId
  )
}
