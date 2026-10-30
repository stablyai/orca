import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isWorkspaceSleepRecord } from '../../../../shared/workspace-sleep'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { recordLayoutApply } from '@/runtime/layout-apply-send'
import type { AppState } from '../types'

type SleepingRecords = Readonly<Record<string, SleepingAgentSessionRecord>>

/** Each tab's entries; a legacy pane key names no pane main holds. */
function byTab<T>(entries: readonly T[], paneKeyOf: (entry: T) => string): Map<string, T[]> {
  const byTabId = new Map<string, T[]>()
  for (const entry of entries) {
    const tabId = parsePaneKey(paneKeyOf(entry))?.tabId
    if (tabId) {
      byTabId.set(tabId, [...(byTabId.get(tabId) ?? []), entry])
    }
  }
  return byTabId
}

/** Record stopped panes’ resume plans in main, one command per tab; recordOnly retains plans for still-running panes. */
export function recordPaneSleepThroughLayoutOwner(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string,
  records: SleepingRecords,
  recordOnly?: true
): void {
  for (const [tabId, tabRecords] of byTab(Object.values(records), (record) => record.paneKey)) {
    recordLayoutApply(state, worktreeId, {
      type: 'sleep',
      tabId,
      paneKeys: tabRecords.map((record) => record.paneKey),
      records: tabRecords,
      ...(recordOnly ? { recordOnly } : {})
    })
  }
}

type HeldRecordsState = Pick<AppState, 'tabsByWorktree'>

/** Diff records only for held tabs; stale captures cannot recreate closed tabs/workspaces. Host-run sleep records are already main-owned. */
export function changedSleepingRecords(
  state: HeldRecordsState,
  previous: SleepingRecords,
  next: SleepingRecords
): { recorded: SleepingAgentSessionRecord[]; dropped: [string, SleepingAgentSessionRecord][] } {
  const held = ([paneKey, record]: [string, SleepingAgentSessionRecord]): boolean =>
    !isWorkspaceSleepRecord(record) &&
    (state.tabsByWorktree[record.worktreeId]?.some(
      (tab) => tab.id === parsePaneKey(paneKey)?.tabId
    ) ??
      false)
  return {
    recorded: Object.entries(next)
      .filter((entry) => previous[entry[0]] !== entry[1] && held(entry))
      .map(([, record]) => record),
    dropped: Object.entries(previous).filter((entry) => !(entry[0] in next) && held(entry))
  }
}

/** Mirror running/quit capture and dropped resume records as commands; main must not learn them only through session saves. */
export function recordSleepingRecordChangesThroughLayoutOwner(
  state: WorktreeRuntimeOwnerState & HeldRecordsState,
  previous: SleepingRecords,
  next: SleepingRecords
): void {
  const { recorded, dropped } = changedSleepingRecords(state, previous, next)
  for (const [worktreeId, records] of Map.groupBy(recorded, (record) => record.worktreeId)) {
    recordPaneSleepThroughLayoutOwner(
      state,
      worktreeId,
      Object.fromEntries(records.map((record) => [record.paneKey, record])),
      true
    )
  }
  for (const [tabId, entries] of byTab(dropped, ([paneKey]) => paneKey)) {
    recordLayoutApply(state, entries[0]![1].worktreeId, {
      type: 'wake',
      tabId,
      paneKeys: entries.map(([paneKey]) => paneKey),
      recordOnly: true
    })
  }
}

/** Record window-resumed pane without starting it again; ordinary main-owned wake also starts the terminal. */
export function recordPaneWakeThroughLayoutOwner(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string,
  paneKey: string
): void {
  const tabId = parsePaneKey(paneKey)?.tabId
  if (tabId) {
    recordLayoutApply(state, worktreeId, {
      type: 'wake',
      tabId,
      paneKeys: [paneKey],
      recordOnly: true
    })
  }
}
