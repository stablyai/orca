import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { findTabForAgentEntry } from './agent-status-pane-key-tab-binding'

export function copyLaunchConfig(config: SleepingAgentLaunchConfig): SleepingAgentLaunchConfig {
  return {
    ...(config.agentCommand ? { agentCommand: config.agentCommand } : {}),
    agentArgs: config.agentArgs,
    agentEnv: { ...config.agentEnv },
    ...(config.ompResumeFilePath ? { ompResumeFilePath: config.ompResumeFilePath } : {})
  }
}

export function sleepingRecordFromEntry(args: {
  state: AppState
  entry: AgentStatusEntry
  worktreeId: string
  tab?: TerminalTab
  capturedAt: number
  launchConfig?: SleepingAgentLaunchConfig
  origin?: SleepingAgentSessionRecord['origin']
}): SleepingAgentSessionRecord | null {
  const agent = args.entry.agentType
  if (
    args.entry.terminalResumeEligible === false ||
    !isResumableTuiAgent(agent) ||
    !args.entry.providerSession
  ) {
    return null
  }
  if (!getAgentResumeArgv(agent, args.entry.providerSession)) {
    return null
  }
  const tab = args.tab ?? findTabForAgentEntry(args.state, args.worktreeId, args.entry)
  return {
    paneKey: args.entry.paneKey,
    ...(tab ? { tabId: tab.id } : {}),
    worktreeId: args.worktreeId,
    agent,
    providerSession: args.entry.providerSession,
    ...(args.entry.connectionId !== undefined ? { connectionId: args.entry.connectionId } : {}),
    prompt: args.entry.prompt,
    state: args.entry.state,
    capturedAt: args.capturedAt,
    updatedAt: args.entry.updatedAt,
    ...((args.entry.terminalTitle ?? tab?.title)
      ? { terminalTitle: (args.entry.terminalTitle ?? tab?.title)! }
      : {}),
    ...(args.entry.lastAssistantMessage
      ? { lastAssistantMessage: args.entry.lastAssistantMessage }
      : {}),
    ...(args.launchConfig ? { launchConfig: copyLaunchConfig(args.launchConfig) } : {}),
    ...(args.entry.interrupted ? { interrupted: true } : {}),
    ...(args.origin ? { origin: args.origin } : {})
  }
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
  return entry.state === 'done' && entry.interrupted !== true
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
// turn's interrupt flag — and an explicitly slept workspace is never stale at wake, so a row the
// user is deliberately sleeping must not trip the wake-side staleness discard. `state` is preserved
// so a done pane wakes lazily in place instead of spawning a new tab.
export function manualSleepCaptureEntry(
  entry: AgentStatusEntry,
  capturedAt: number
): AgentStatusEntry {
  return { ...entry, updatedAt: capturedAt, interrupted: false }
}

// Why: capture recreates a record the manual-sleep wipe would otherwise remove, so a deliberately
// blocked worker must not become auto-resumable at wake.
export function carryOverAutomaticResumeBlock(
  record: SleepingAgentSessionRecord,
  previous: SleepingAgentSessionRecord | undefined
): void {
  if (
    previous?.automaticResumeBlockedBy === 'legacy-orchestration-worker' &&
    previous.agent === record.agent &&
    agentProviderSessionsEqual(record.agent, previous.providerSession, record.providerSession)
  ) {
    record.automaticResumeBlockedBy = previous.automaticResumeBlockedBy
  }
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
