import type { AppState } from '../../types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import { agentTurnEndedUncleanly } from '../../../../../shared/agent-main-agent-verdict'
import type {
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../../../shared/agent-session-resume'
import { resumeRecordFromStatus } from '../../../../../shared/agent-resume-record-from-status'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import { findTabForAgentEntry } from './agent-status-pane-key-tab-binding'

export function sleepingRecordFromEntry(args: {
  state: AppState
  entry: AgentStatusEntry
  worktreeId: string
  tab?: TerminalTab
  capturedAt: number
  launchConfig?: SleepingAgentLaunchConfig
  origin?: SleepingAgentSessionRecord['origin']
}): SleepingAgentSessionRecord | null {
  const { state, tab, ...record } = args
  return resumeRecordFromStatus({
    ...record,
    tabOf: () => tab ?? findTabForAgentEntry(state, args.worktreeId, args.entry)
  })
}

export type CollectSleepingAgentSessionRecordsOptions = {
  paneKeys?: readonly string[]
  captureMode?: 'manual-worktree-sleep' | 'completed-agent-hibernation'
}

export function normalizeSleepingAgentSessionCollectOptions(
  options: readonly string[] | CollectSleepingAgentSessionRecordsOptions | undefined
): CollectSleepingAgentSessionRecordsOptions {
  if (!options) {
    return {}
  }
  return Array.isArray(options)
    ? { paneKeys: options }
    : (options as CollectSleepingAgentSessionRecordsOptions)
}

export function isValidCompletedAgentHibernationEntry(entry: AgentStatusEntry): boolean {
  return entry.state === 'done' && !agentTurnEndedUncleanly(entry)
}

// Done recovery stays passive: mobile wake background-mounts passive tabs and would respawn all work. Restore via --resume only when opened (#11598).
export function markManualSleepLazyRestore(record: SleepingAgentSessionRecord): void {
  if (record.state === 'done') {
    record.restoreOnTabOpenOnly = true
  }
}

// Fresh captures replace provisional live/legacy checkpoints; explicit sleep/quit records may be the only surviving resume handle.
export function isDurableSleepingCapture(record: SleepingAgentSessionRecord): boolean {
  return record.origin === 'worktree-sleep' || record.origin === 'quit'
}

// Manual sleep kills PTY; capture resume identity without wake-side staleness discard. Preserve state so done panes resume lazily in place.
export function manualSleepCaptureEntry(
  entry: AgentStatusEntry,
  capturedAt: number
): AgentStatusEntry {
  if (!entry.mainAgent) {
    return { ...entry, updatedAt: capturedAt, interrupted: false }
  }
  const { outcome: _outcome, ...mainAgent } = entry.mainAgent
  return { ...entry, updatedAt: capturedAt, interrupted: false, mainAgent }
}

export function removeSleepingRecordsReplacedByManualWorktreeSleep(
  records: Record<string, SleepingAgentSessionRecord>,
  worktreeId: string,
  paneKeys?: readonly string[],
  replacements?: Readonly<Record<string, SleepingAgentSessionRecord>>
): { records: Record<string, SleepingAgentSessionRecord>; changed: boolean } {
  const allowedPaneKeys = paneKeys ? new Set(paneKeys) : null
  let next = records
  let changed = false
  for (const [paneKey, record] of Object.entries(records)) {
    if (record.worktreeId !== worktreeId || (allowedPaneKeys && !allowedPaneKeys.has(paneKey))) {
      continue
    }
    // Repeated sleep lacks live rows for never-woken panes; retain durable records it cannot rederive (#11598).
    if (!replacements?.[paneKey] && isDurableSleepingCapture(record)) {
      continue
    }
    if (next === records) {
      next = { ...records }
    }
    delete next[paneKey]
    changed = true
  }
  return { records: next, changed }
}
