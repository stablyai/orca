import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { isPassiveCompletedHibernationEvidence } from '../../lib/sleeping-agent-pane-ownership'
import { createWorktreeRecordSelector } from '@/store/worktree-record-selector-cache'

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

type SleepingRecordParkExemptionState = {
  sleepingAgentSessionsByPaneKey?: Record<string, SleepingAgentSessionRecord>
}

/** Tab ids whose panes own a sleeping record a mount can actually consume.
 *  Why: a parked pane can never cold-restore, so per-tab parks must exempt
 *  these — but only these: passive-completed records never resume,
 *  and exempting them would pin a hidden pane mounted indefinitely.
 *
 *  Why memoized on the record map's identity (STA-7552): zustand re-runs every
 *  mounted subscriber's selector on every store write, so an unrelated pane
 *  title update used to walk the whole inventory once per retained worktree.
 *  The map changes only when a record is parked or consumed, so that identity
 *  is the exact gate.
 *  Iterates in place — `Object.values` would allocate every record per rebuild. */
export const selectSleepingRecordParkExemptTabIds = createWorktreeRecordSelector<
  SleepingRecordParkExemptionState,
  ReadonlySet<string>
>({
  readSources: (state) => [state.sleepingAgentSessionsByPaneKey],
  empty: EMPTY_TAB_IDS,
  build: ({ sleepingAgentSessionsByPaneKey }, worktreeId) => {
    if (!sleepingAgentSessionsByPaneKey) {
      return EMPTY_TAB_IDS
    }
    let owned: Set<string> | null = null
    for (const paneKey in sleepingAgentSessionsByPaneKey) {
      const record = sleepingAgentSessionsByPaneKey[paneKey]
      if (!record || record.worktreeId !== worktreeId) {
        continue
      }
      if (isPassiveCompletedHibernationEvidence(record)) {
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
})
