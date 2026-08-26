import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { isPassiveCompletedHibernationEvidence } from '../../lib/sleeping-agent-pane-ownership'

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()
const TAB_ID_SEPARATOR = '\u0000'

/** Tab ids whose panes own a sleeping record a mount can actually consume, as a
 *  value-comparable key.
 *  Why: a parked pane can never cold-restore, so per-tab parks must exempt
 *  these — but only these: blocked and passive-completed records never resume,
 *  and exempting them would pin a hidden pane mounted indefinitely.
 *  Why a key: the record map is app-global, so a subscriber must compare the
 *  worktree-scoped verdict, not the map. Iterates in place — `Object.values`
 *  would allocate every record on every store write. */
export function selectSleepingRecordParkExemptTabIdsKey(
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> | undefined,
  worktreeId: string
): string {
  if (!sleepingAgentSessionsByPaneKey) {
    return ''
  }
  let owned: string[] | null = null
  for (const paneKey in sleepingAgentSessionsByPaneKey) {
    const record = sleepingAgentSessionsByPaneKey[paneKey]
    if (!record || record.worktreeId !== worktreeId) {
      continue
    }
    if (record.automaticResumeBlockedBy || isPassiveCompletedHibernationEvidence(record)) {
      continue
    }
    const tabId = record.tabId ?? record.paneKey.slice(0, record.paneKey.indexOf(':'))
    if (tabId && !owned?.includes(tabId)) {
      owned ??= []
      owned.push(tabId)
    }
  }
  // Why sorted: record insertion order must not churn the key and the derived set.
  return owned === null ? '' : owned.sort().join(TAB_ID_SEPARATOR)
}

export function parseSleepingRecordParkExemptTabIdsKey(key: string): ReadonlySet<string> {
  return key === '' ? EMPTY_TAB_IDS : new Set(key.split(TAB_ID_SEPARATOR))
}
