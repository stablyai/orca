import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  agentTurnEndedUncleanly,
  agentVerdictFields
} from '../../../../shared/agent-main-agent-verdict'
import {
  getAgentResumeArgv,
  isResumableTuiAgent,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { terminalLayoutNodeLeafIds } from '../../../../shared/native-chat-leaf-ownership'
import { isComposerChatTarget } from '../../../../shared/native-chat-target-read'
import { findTabForAgentEntry } from './agent-status-pane-key-tab-binding'
import { readTerminalChatPair } from './tabs/terminal-chat-pair-state'

export function copyLaunchConfig(config: SleepingAgentLaunchConfig): SleepingAgentLaunchConfig {
  return {
    ...(config.agentCommand ? { agentCommand: config.agentCommand } : {}),
    agentArgs: config.agentArgs,
    agentEnv: { ...config.agentEnv },
    ...(config.ompResumeFilePath ? { ompResumeFilePath: config.ompResumeFilePath } : {})
  }
}

/**
 * The view this pane showed, so a wake restores it: chat only for the pane that owned the tab's
 * chat (a sibling of a split chat tab showed terminal), absent for a tab nobody switched.
 */
function sleepingPaneViewMode(
  state: AppState,
  tabId: string,
  paneKey: string
): SleepingAgentSessionRecord['viewMode'] {
  const pair = readTerminalChatPair(state, tabId)
  if (!pair?.viewMode) {
    return undefined
  }
  const leafId = parsePaneKey(paneKey)?.leafId
  const ownsChat =
    pair.viewMode === 'chat' &&
    leafId !== undefined &&
    isComposerChatTarget({
      viewMode: 'chat',
      chatLeafId: pair.chatLeafId ?? undefined,
      launchAgent: undefined,
      leafIds: terminalLayoutNodeLeafIds(state.terminalLayoutsByTabId[tabId]?.root),
      leafId
    })
  return ownsChat ? 'chat' : 'terminal'
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
  // Why not on live checkpoints: they are rebuilt only on status events, so a view switch would go stale.
  const viewMode =
    tab && args.origin !== 'live'
      ? sleepingPaneViewMode(args.state, tab.id, args.entry.paneKey)
      : undefined
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
    ...(viewMode ? { viewMode } : {}),
    ...agentVerdictFields(args.entry),
    ...(args.origin ? { origin: args.origin } : {})
  }
}

/** A record made durable from a checkpoint takes its view from the tab now; a gone tab keeps none. */
export function withSleepingPaneView(
  state: AppState,
  record: SleepingAgentSessionRecord
): SleepingAgentSessionRecord {
  const tabId = record.tabId
  const tabExists =
    tabId !== undefined &&
    state.tabsByWorktree[record.worktreeId]?.some((tab) => tab.id === tabId) === true
  const viewMode = tabExists ? sleepingPaneViewMode(state, tabId, record.paneKey) : undefined
  if (viewMode === record.viewMode) {
    return record
  }
  const next = { ...record }
  if (viewMode) {
    next.viewMode = viewMode
  } else {
    delete next.viewMode
  }
  return next
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
