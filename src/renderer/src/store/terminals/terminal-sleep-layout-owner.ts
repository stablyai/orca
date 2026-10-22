import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
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

/**
 * A layout-owner build's record of panes this window put to sleep and already stopped: main
 * records how each pane's agent resumes, one command per tab. The window decides (planner, user
 * sleep) and stops the terminals. `recordOnly`: the panes still run; main only keeps the records.
 */
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

/**
 * The resume records `next` sets or replaces since `previous`, and the ones it drops, of panes in
 * tabs the window holds: a closed tab's or removed workspace's records went with it in main, and a
 * capture from a stale agent status names a tab main no longer has.
 */
export function changedSleepingRecords(
  state: HeldRecordsState,
  previous: SleepingRecords,
  next: SleepingRecords
): { recorded: SleepingAgentSessionRecord[]; dropped: [string, SleepingAgentSessionRecord][] } {
  const held = ([paneKey, record]: [string, SleepingAgentSessionRecord]): boolean =>
    state.tabsByWorktree[record.worktreeId]?.some(
      (tab) => tab.id === parsePaneKey(paneKey)?.tabId
    ) ?? false
  return {
    recorded: Object.entries(next)
      .filter((entry) => previous[entry[0]] !== entry[1] && held(entry))
      .map(([, record]) => record),
    dropped: Object.entries(previous).filter((entry) => !(entry[0] in next) && held(entry))
  }
}

/**
 * Every change of the window's resume records, as record-only commands: live and quit captures of
 * running agents, records a resume or close dropped, and the rest no sleep or wake command sends.
 * Without these main learned the records only from the window's session save.
 */
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

/**
 * A layout-owner build's record of the one pane this window showed and resumed itself: record-only,
 * since a plain wake has main start the pane too.
 */
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
