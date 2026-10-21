import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { agentTurnEndedUncleanly } from '../../../../shared/agent-main-agent-verdict'
import type {
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import { resumeRecordFromStatus } from '../../../../shared/agent-resume-record-from-status'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
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

// Why: a finished pane is passive wake evidence, and a mobile wake background-mounts every passive
// record's tab. Sleeping a workspace must not become "one phone tap respawns all of it" — the pane
// issues its own `--resume` cold restore when its tab is opened instead (#11598).
export function markManualSleepLazyRestore(record: SleepingAgentSessionRecord): void {
  if (record.state === 'done') {
    record.restoreOnTabOpenOnly = true
  }
}

// Why: `live`/legacy rows are provisional checkpoints a fresh capture supersedes; an explicit
// sleep or quit capture is the pane's only resume handle once its live row is gone.
export function isDurableSleepingCapture(record: SleepingAgentSessionRecord): boolean {
  return record.origin === 'worktree-sleep' || record.origin === 'quit'
}

// Why: manual sleep kills the pty either way, so the record carries resume identity, not the dead
// turn's verdict — and an explicitly slept workspace is never stale at wake, so a row the
// user is deliberately sleeping must not trip the wake-side staleness discard. `state` is preserved
// so a done pane wakes lazily in place instead of spawning a new tab.
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
    // Why: a repeat sleep must not delete a durable record this capture cannot re-derive — the
    // pane was never woken, so it has no live status row to rebuild it from (#11598).
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
