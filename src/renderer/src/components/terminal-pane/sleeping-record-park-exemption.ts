import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { activationTreatsNoteAsFinished } from '../../lib/sleeping-agent-pane-ownership'
import { createWorktreeRecordSelector } from '@/store/worktree-record-selector-cache'

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

type SleepingRecordParkExemptionState = {
  sleepingAgentSessionsByPaneKey?: Record<string, SleepingAgentSessionRecord>
}

/** Exempt only consumable sleeping records: parked panes cannot cold-restore, but finished notes would pin panes forever. Memoize by record-map identity to avoid rescanning every worktree on unrelated writes; iterate without allocating Object.values. */
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
      if (activationTreatsNoteAsFinished(record)) {
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
