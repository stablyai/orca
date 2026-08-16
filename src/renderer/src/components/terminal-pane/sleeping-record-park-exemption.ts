import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { isPassiveCompletedHibernationEvidence } from '../../lib/sleeping-agent-pane-ownership'

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

/** Tab ids whose panes own a sleeping record a mount can actually consume.
 *  Why: a parked pane can never cold-restore, so per-tab parks must exempt
 *  these — but only these: blocked and passive-completed records never resume,
 *  and exempting them would pin a hidden pane mounted indefinitely. */
export function selectSleepingRecordParkExemptTabIds(
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> | undefined,
  worktreeId: string
): ReadonlySet<string> {
  let owned: Set<string> | null = null
  for (const record of Object.values(sleepingAgentSessionsByPaneKey ?? {})) {
    if (record.worktreeId !== worktreeId) {
      continue
    }
    if (record.automaticResumeBlockedBy || isPassiveCompletedHibernationEvidence(record)) {
      continue
    }
    const tabId = record.tabId ?? record.paneKey.slice(0, record.paneKey.indexOf(':'))
    if (tabId) {
      owned ??= new Set()
      owned.add(tabId)
    }
  }
  return owned ?? EMPTY_TAB_IDS
}
