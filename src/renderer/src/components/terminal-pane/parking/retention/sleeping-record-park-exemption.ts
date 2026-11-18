import type { SleepingAgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../../../shared/workspace-layout/stable-pane-id'
import { activationTreatsNoteAsFinished } from '../../../../lib/agent-session/resume/sleeping-agent-pane-ownership'
import { sleepingAgentRecordIndex } from '@/store/terminals/sleep/sleeping-agent-record-index'

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

type SleepingRecordParkExemptionState = {
  sleepingAgentSessionsByPaneKey?: Record<string, SleepingAgentSessionRecord>
}

const exemptionsByEntries = new WeakMap<object, ReadonlySet<string>>()

/** Only consumable parsed records pin panes; raw prefix ownership is a separate coverage fact. */
export function selectSleepingRecordParkExemptTabIds(
  state: SleepingRecordParkExemptionState,
  worktreeId: string
): ReadonlySet<string> {
  if (!state.sleepingAgentSessionsByPaneKey) {
    return EMPTY_TAB_IDS
  }
  const entries = sleepingAgentRecordIndex.entries(state.sleepingAgentSessionsByPaneKey, worktreeId)
  let tabIds = exemptionsByEntries.get(entries)
  if (!tabIds) {
    const ids = new Set<string>()
    for (const [, record] of entries) {
      if (activationTreatsNoteAsFinished(record)) {
        continue
      }
      const tabId =
        record.tabId ??
        parsePaneKey(record.paneKey)?.tabId ??
        parseLegacyNumericPaneKey(record.paneKey)?.tabId
      if (tabId) {
        ids.add(tabId)
      }
    }
    tabIds = ids
    exemptionsByEntries.set(entries, tabIds)
  }
  return tabIds
}
