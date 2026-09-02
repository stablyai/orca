import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { isPassiveCompletedHibernationEvidence } from '../../lib/sleeping-agent-pane-ownership'

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

/** Tab ids whose panes own a sleeping record a mount can actually consume.
 *  Why: a parked pane can never cold-restore, so per-tab parks must exempt
 *  these — but only these: blocked and passive-completed records never resume,
 *  and exempting them would pin a hidden pane mounted indefinitely.
 *  Callers subscribe through `useShallow`, which compares the set structurally,
 *  so a write for another worktree cannot re-render this one. Iterates in place —
 *  `Object.values` would allocate every record on every store write. */
export function selectSleepingRecordParkExemptTabIds(
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> | undefined,
  worktreeId: string
): ReadonlySet<string> {
  if (!sleepingAgentSessionsByPaneKey) {
    return EMPTY_TAB_IDS
  }
  let owned: Set<string> | null = null
  for (const paneKey in sleepingAgentSessionsByPaneKey) {
    const record = sleepingAgentSessionsByPaneKey[paneKey]
    if (!record || record.worktreeId !== worktreeId) {
      continue
    }
    if (record.automaticResumeBlockedBy || isPassiveCompletedHibernationEvidence(record)) {
      continue
    }
    // Why: malformed pane keys must yield no owner instead of a truncated tab id.
    const tabId =
      record.tabId ??
      parsePaneKey(record.paneKey)?.tabId ??
      parseLegacyNumericPaneKey(record.paneKey)?.tabId
    if (tabId) {
      owned ??= new Set()
      owned.add(tabId)
    }
  }
  return owned ?? EMPTY_TAB_IDS
}
