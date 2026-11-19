import { useAppStore } from '@/store/index'
import { sleepingAgentRecordIndex } from '@/store/terminals/sleep/sleeping-agent-record-index'
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
  tabIds: readonly string[],
  paneKey?: string
): void {
  const wanted = new Set(tabIds)
  for (const [, record] of sleepingAgentRecordIndex.entries(
    useAppStore.getState().sleepingAgentSessionsByPaneKey,
    worktreeId
  )) {
    const tabId = getSleepingRecordTabId(record)
    if (
      record.worktreeId === worktreeId &&
      tabId !== null &&
      wanted.has(tabId) &&
      (!paneKey || record.paneKey === paneKey)
    ) {
      requestedRecords.add(record)
    }
  }
}

const mailWakeLaunchTokens = new Map<string, string>()

/** A mail wake's resume launches under main's attempt id, so main can tell which process it started. */
export function rememberMailWakeLaunchToken(
  paneKey: string,
  launchToken: string | undefined
): void {
  if (launchToken) {
    mailWakeLaunchTokens.set(paneKey, launchToken)
  } else {
    mailWakeLaunchTokens.delete(paneKey)
  }
}

export function takeMailWakeLaunchToken(paneKey: string): string | undefined {
  const launchToken = mailWakeLaunchTokens.get(paneKey)
  mailWakeLaunchTokens.delete(paneKey)
  return launchToken
}

export function takeSleepingAgentWakeRequest(record: SleepingAgentSessionRecord): boolean {
  return requestedRecords.delete(record)
}
