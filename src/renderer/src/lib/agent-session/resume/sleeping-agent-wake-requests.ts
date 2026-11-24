import { useAppStore } from '@/store/index'
import { sleepingAgentRecordIndex } from '@/store/terminals/sleep/sleeping-agent-record-index'
import {
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../../shared/workspace-layout/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { getProviderSessionClaimKey } from '../../../../../shared/agent-session/lifecycle/resume/sleeping-record-legacy-pane-key'
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

type RequestSleepingAgentWakeOnMountOptions = {
  paneKey?: string
  skipClaimKeys?: ReadonlySet<string>
}

/** Asks the named tabs' sleeping agents to start when their panes mount hidden. Claim keys the host
 * still holds live are skipped: waking such a pane starts a second `--resume` writer (STA-3859). */
export function requestSleepingAgentWakeOnMount(
  worktreeId: string,
  tabIds: readonly string[],
  options?: RequestSleepingAgentWakeOnMountOptions
): void {
  const paneKey = options?.paneKey
  const skipClaimKeys = options?.skipClaimKeys
  const wanted = new Set(tabIds)
  if (paneKey) {
    // A targeted wake authorizes its one record, not the workspace's, while still honoring host claims (STA-3859).
    const record = useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]
    const tabId = record ? getSleepingRecordTabId(record) : null
    if (
      record?.worktreeId === worktreeId &&
      tabId !== null &&
      wanted.has(tabId) &&
      skipClaimKeys?.has(getProviderSessionClaimKey(record)) !== true
    ) {
      markSleepingAgentWakeRequest(record)
    }
    return
  }
  for (const [, record] of sleepingAgentRecordIndex.entries(
    useAppStore.getState().sleepingAgentSessionsByPaneKey,
    worktreeId
  )) {
    // Explicit sleep stays asleep until its own tab opens; a sibling record's targeted wake must not
    // wake it just because the two share a tab (#11598). A host-claimed record in a mounted tab is
    // the same hazard: its pane reattaches, so a wake mark would only release a duplicate writer.
    if (
      record.restoreOnTabOpenOnly === true ||
      skipClaimKeys?.has(getProviderSessionClaimKey(record)) === true
    ) {
      continue
    }
    const tabId = getSleepingRecordTabId(record)
    if (record.worktreeId === worktreeId && tabId !== null && wanted.has(tabId)) {
      markSleepingAgentWakeRequest(record)
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
