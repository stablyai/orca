import type { SleepingAgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../../../shared/workspace-layout/stable-pane-id'
import { activationTreatsNoteAsFinished } from '../../../../lib/agent-session/resume/sleeping-agent-pane-ownership'
import { createWorktreeRecordSelector } from '@/store/terminals/worktree-terminal-record-selector'

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

type SleepingRecordParkExemptionState = {
  sleepingAgentSessionsByPaneKey?: Record<string, SleepingAgentSessionRecord>
}

let exemptTabIdsByWorktreeCache: {
  records: Record<string, SleepingAgentSessionRecord>
  byWorktreeId: ReadonlyMap<string, ReadonlySet<string>>
} | null = null

/** Group consumable records by worktree once per record map; each mounted worktree then reads its bucket instead of rescanning every record. */
function exemptTabIdsByWorktree(
  records: Record<string, SleepingAgentSessionRecord>
): ReadonlyMap<string, ReadonlySet<string>> {
  if (exemptTabIdsByWorktreeCache?.records === records) {
    return exemptTabIdsByWorktreeCache.byWorktreeId
  }
  const byWorktreeId = new Map<string, Set<string>>()
  for (const paneKey in records) {
    const record = records[paneKey]
    if (!record || activationTreatsNoteAsFinished(record)) {
      continue
    }
    // Why: malformed pane keys must yield no owner instead of a truncated tab id.
    const tabId =
      record.tabId ??
      parsePaneKey(record.paneKey)?.tabId ??
      parseLegacyNumericPaneKey(record.paneKey)?.tabId
    if (tabId) {
      let owned = byWorktreeId.get(record.worktreeId)
      if (!owned) {
        owned = new Set()
        byWorktreeId.set(record.worktreeId, owned)
      }
      owned.add(tabId)
    }
  }
  exemptTabIdsByWorktreeCache = { records, byWorktreeId }
  return byWorktreeId
}

/** Exempt only consumable sleeping records: parked panes cannot cold-restore, but finished notes would pin panes forever. Memoize by record-map identity to avoid rescanning every worktree on unrelated writes. */
export const selectSleepingRecordParkExemptTabIds = createWorktreeRecordSelector<
  SleepingRecordParkExemptionState,
  ReadonlySet<string>
>({
  readSources: (state) => [state.sleepingAgentSessionsByPaneKey],
  empty: EMPTY_TAB_IDS,
  build: ({ sleepingAgentSessionsByPaneKey }, worktreeId) =>
    sleepingAgentSessionsByPaneKey
      ? (exemptTabIdsByWorktree(sleepingAgentSessionsByPaneKey).get(worktreeId) ?? EMPTY_TAB_IDS)
      : EMPTY_TAB_IDS
})
