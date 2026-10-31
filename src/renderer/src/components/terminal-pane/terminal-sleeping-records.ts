import type { useAppStore } from '@/store'
import { findLegacyNumericSleepingRecord } from '../../../../shared/sleeping-record-legacy-pane-key'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'

export const getSleepingRecordForPane = (
  state: ReturnType<typeof useAppStore.getState>,
  binding: { paneKey: string; tabId: string; worktreeId: string; paneId?: number }
): { paneKey: string; record: SleepingAgentSessionRecord } | null => {
  const stableRecord = state.sleepingAgentSessionsByPaneKey[binding.paneKey]
  if (stableRecord) {
    return { paneKey: binding.paneKey, record: stableRecord }
  }
  const legacy = findLegacyNumericSleepingRecord(
    state.sleepingAgentSessionsByPaneKey,
    { tabId: binding.tabId, numericPaneId: String(binding.paneId) },
    (record) => record.worktreeId === binding.worktreeId
  )
  return legacy ? { paneKey: legacy.paneKey, record: legacy.record } : null
}
export const clearSleepingRecordProviderDuplicates = (
  state: ReturnType<typeof useAppStore.getState>,
  consumed: { paneKey: string; record: SleepingAgentSessionRecord }
): void => {
  state.clearSleepingAgentSession(consumed.paneKey)
  for (const [paneKey, record] of Object.entries(state.sleepingAgentSessionsByPaneKey)) {
    if (
      paneKey !== consumed.paneKey &&
      record.worktreeId === consumed.record.worktreeId &&
      record.agent === consumed.record.agent &&
      agentProviderSessionsEqual(
        record.agent,
        record.providerSession,
        consumed.record.providerSession
      )
    ) {
      // Why: legacy pane aliases can leave multiple sleeping rows for one
      // provider session; once this pane resumes it, every alias is stale.
      state.clearSleepingAgentSession(paneKey)
    }
  }
}
