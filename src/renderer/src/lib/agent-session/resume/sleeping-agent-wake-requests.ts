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
  if (paneKey) {
    // A targeted wake authorizes its one record, not the workspace's.
    const record = useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]
    const tabId = record ? getSleepingRecordTabId(record) : null
    if (record?.worktreeId === worktreeId && tabId !== null && wanted.has(tabId)) {
      requestedRecords.add(record)
    }
    return
  }
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

// Why record identity: a removed or replaced record drops its token, so an abandoned wake retains nothing.
const mailWakeLaunchTokens = new WeakMap<SleepingAgentSessionRecord, string>()

/** A mail wake's resume launches under main's attempt id, so main can tell which process it started. */
export function rememberMailWakeLaunchToken(
  paneKey: string,
  launchToken: string | undefined
): void {
  const record = useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]
  if (record && launchToken) {
    mailWakeLaunchTokens.set(record, launchToken)
  } else if (record) {
    mailWakeLaunchTokens.delete(record)
  }
}

export function forgetMailWakeLaunchToken(paneKey: string, launchToken: string): void {
  const record = useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]
  if (record && mailWakeLaunchTokens.get(record) === launchToken) {
    mailWakeLaunchTokens.delete(record)
  }
}

/** Read, not taken: every startup built for this wake (probes included) launches under main's id
 *  until the wake settles or the record is replaced. */
export function mailWakeLaunchToken(
  record: SleepingAgentSessionRecord | undefined
): string | undefined {
  return record ? mailWakeLaunchTokens.get(record) : undefined
}

export function takeSleepingAgentWakeRequest(record: SleepingAgentSessionRecord): boolean {
  return requestedRecords.delete(record)
}
