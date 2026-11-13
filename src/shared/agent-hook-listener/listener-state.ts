import type { AgentMainAgentStatus } from '../agent-status/lifecycle/main-agent-status'
import type { AgentChildWorkKind } from '../agent-status/child-work/agent-status-child-work'
import type { ClaudeLeadTurnState, CodexLeadTurnState } from './main-agent-turn-state'

import {
  createAgentStatusLegacyAdapter,
  type AgentStatusLegacyAdapter,
  type AgentStatusLegacyAdapterOptions,
  type AgentStatusLegacyAdmissionMode
} from '../agent-status/transport/agent-status-legacy-adapter'
import type { AgentStatusLegacyIngressCaller } from '../agent-status/transport/agent-status-legacy-ingress-manifest'
import type { ClaudeLaunchedBackgroundTasks } from './providers/claude/background-tasks/claude-owed-task-notifications'
import type { ClaudeSubagentRoster } from '../claude-subagent-roster'
import type { ClaudeToolRequest } from './claude-tool-request-identity'
import type { CodexSubagentRoster } from '../codex-subagent-roster'
import type { CodexSubagentTranscriptState } from '../codex-subagent-transcript'
import type { CodexAsyncQuestions } from './providers/codex/codex-async-questions'
import type { MuseSessionLogState } from '../muse-session-log'
import type { AgentHookEventPayload, ToolSnapshot } from './listener-event'
import {
  deletePaneScopedCacheEntry,
  deletePaneScopedSetEntry,
  movePaneScopedMapEntries,
  movePaneScopedSetEntries
} from './pane-scoped-cache-entries'
import type { JcodeUserPromptEvidence } from '../jcode-session-files'
import type { JcodeHelperPermissionWait } from './providers/jcode/jcode-helper-permission-wait'
import type { HookRootAttempt } from './presence/hook-process-root-evidence'
import {
  moveOpenCodeSessionBindings,
  unbindOpenCodeSessionsOfPane,
  type OpenCodeSessionBinding
} from './opencode-session-registry'

/** Per-listener-instance caches needing per-PTY teardown; Orca's main process and the relay each get their own, never shared. */
export type HookListenerState = {
  warnedVersions: Set<string>
  warnedEnvs: Set<string>
  lastPromptByPaneKey: Map<string, string>
  lastToolByPaneKey: Map<string, ToolSnapshot>
  /** Reply text the event being normalized carried; normalizeProviderEvent takes and clears it, so it never outlives that event. */
  eventReplyCandidate: string | undefined
  /** Read-only compatibility view. All writes pass through the isolated legacy adapter. */
  lastStatusByPaneKey: ReadonlyMap<string, AgentHookEventPayload>
  antigravityCompletedTranscriptByPaneKey: Map<string, string>
  /** Work outliving the turn, kept until agy's fully idle Stop: the conversation that spawned in-process subagents,
   *  and run_command steps agy backgrounded (PreToolUse seen, the PostToolUse it sends when the command ends not yet). */
  antigravityChildWorkByPaneKey: Map<string, { subagentParent?: string; commands?: Set<string> }>
  /** Journal-backed prompt for each jcode pane's current turn; see readJcodeTurnPrompt. */
  jcodeTurnPromptByPaneKey: Map<string, JcodeUserPromptEvidence | null>
  /** Open swarm-helper permission requests per jcode pane; see routeJcodeHelperHook. */
  jcodeHelperPermissionWaitByPaneKey: Map<string, JcodeHelperPermissionWait>
  ampCompletedCacheKeys: Set<string>
  /** Live subagents/teammates per Claude pane; survives turn boundaries since background children outlive the lead turn. */
  claudeSubagentRosterByPaneKey: Map<string, ClaudeSubagentRoster>
  /** Lead-only state published as mainAgent; retain verdict through child churn until final done. */
  claudeLeadStateByPaneKey: Map<string, ClaudeLeadTurnState>
  /** Claude calls whose PreToolUse arrived and that have not resolved; a PermissionRequest asks about one of them. */
  claudeOpenToolUsesByPaneKey: Map<string, ClaudeToolRequest[]>
  /** One-normalization provenance marker for a status backed only by restored child state. */
  claudeUnconfirmedRestoredStatusPaneKeys: Set<string>
  /** Panes whose latest authoritative Claude task inventory still has running non-agent work. */
  claudeRunningNonAgentTaskPaneKeys: Set<string>
  /** Panes whose latest authoritative Claude cron inventory still has a scheduled job. */
  claudeActiveSessionCronPaneKeys: Set<string>
  /** Background tasks each pane's main agent launched, and which of them still owe it a notification. */
  claudeLaunchedBackgroundTasksByPaneKey: Map<string, ClaudeLaunchedBackgroundTasks>
  /** Compact whose completion each pane already applied, so relay duplicates can't refresh the row. */
  claudeConsumedCompactPromptIdByPaneKey: Map<string, string>
  /** Lead session_id changes retire replaced-conversation claims even without SessionStart (/clear/relaunch/resume). */
  claudeSessionOwnerByPaneKey: Map<string, string>
  /** Execution-host evidence attempts for processes acquiring a pane, by pane and process identity. */
  hookRootAttempts: Map<string, HookRootAttempt>
  /** Live thread-spawn children per Codex pane. */
  codexSubagentRosterByPaneKey: Map<string, CodexSubagentRoster>
  /** Incremental parent/child rollout cursors for Codex collaboration v2. */
  codexSubagentTranscriptByPaneKey: Map<string, CodexSubagentTranscriptState>
  /** Root Codex state/model, kept separate from child hook traffic. */
  codexLeadStateByPaneKey: Map<string, CodexLeadTurnState>
  /** Mid-turn async questions Codex's TUI holds open; its own status keeps saying working. */
  codexAsyncQuestionsByPaneKey: Map<string, CodexAsyncQuestions>
  /** Ephemeral forked Codex threads (/side) per pane; they never own the pane's status. */
  codexEphemeralForkSessionsByPaneKey: Map<string, string[]>
  /** A rollout-less Codex start held until its prompt shows a new conversation or the hidden title thread. */
  codexHeldEphemeralStartByPaneKey: Map<string, string>
  /** Newest Grok turn per pane, used to reject end reports that arrive after a replacement prompt. */
  grokActiveTurnByPaneKey: Map<string, GrokActiveTurn>
  /** The Grok main agent's own state as last published, so its clock keeps continuity across events. */
  grokMainAgentStatusByPaneKey: Map<string, AgentMainAgentStatus>
  /** Grok background shells and subagents still running, by Grok's task id; a cancel report omits them. */
  grokBackgroundTasksByPaneKey: Map<string, Map<string, AgentChildWorkKind>>
  /** Muse child-session filter and session-log cursor per pane. */
  musePaneStateByPaneKey: Map<string, MusePaneState>
  /** Client-observed OpenCode1 session ownership replaces frozen shared-server stamps before ingest. This map names owners, not status claims. */
  opencodeSessionPaneBySessionId: Map<string, OpenCodeSessionBinding>
  /** Last launch token seen per pane; a rewritten shared-server post needs the bound pane's live token to pass its fence. */
  lastLaunchTokenByPaneKey: Map<string, string>
  /** Hermes turn per pane, so tool hooks from its post-turn background review can be ignored. */
  hermesTurnByPaneKey: Map<string, HermesPaneTurn>
}

export type HermesPaneTurn = {
  ended: boolean
  /** `delegate_task` children run their own turns, under their own session ids, inside the parent's. */
  childSessionIds: Set<string>
  /** The pane's own session, which its children's hooks must not replace. */
  sessionId: string
}

export type MusePaneState = {
  /** Internal reminder/subagent sessions; their hooks inherit the pane env and fire even after Stop. */
  childSessionIds: Set<string>
  /** Spawned subagents between SubagentStart and SubagentStop, by child session id, with their last hook time. */
  runningChildren: Map<string, number>
  /** Main-agent status as last derived, so restatements keep its clock. */
  mainAgent?: AgentMainAgentStatus
  log?: MuseSessionLogState
  /** Muse emits PermissionRequest for auto-approved calls too; only Notification confirms a visible prompt. */
  pendingApproval?: { toolName?: string; toolInput?: unknown }
}

export type GrokActiveTurn = {
  promptId?: string
  sessionId?: string
}

const legacyStatusAdapterByState = new WeakMap<HookListenerState, AgentStatusLegacyAdapter>()

function legacyStatusAdapter(state: HookListenerState): AgentStatusLegacyAdapter {
  const adapter = legacyStatusAdapterByState.get(state)
  if (!adapter) {
    throw new Error('Hook listener state has no legacy agent-status adapter')
  }
  return adapter
}

export function createHookListenerState(
  options: AgentStatusLegacyAdapterOptions = {}
): HookListenerState {
  const adapter = createAgentStatusLegacyAdapter(options)
  const state: HookListenerState = {
    warnedVersions: new Set(),
    warnedEnvs: new Set(),
    lastPromptByPaneKey: new Map(),
    lastToolByPaneKey: new Map(),
    eventReplyCandidate: undefined,
    lastStatusByPaneKey: adapter.view,
    antigravityCompletedTranscriptByPaneKey: new Map(),
    antigravityChildWorkByPaneKey: new Map(),
    jcodeTurnPromptByPaneKey: new Map(),
    jcodeHelperPermissionWaitByPaneKey: new Map(),
    ampCompletedCacheKeys: new Set(),
    claudeSubagentRosterByPaneKey: new Map(),
    claudeLeadStateByPaneKey: new Map(),
    claudeOpenToolUsesByPaneKey: new Map(),
    claudeUnconfirmedRestoredStatusPaneKeys: new Set(),
    claudeRunningNonAgentTaskPaneKeys: new Set(),
    claudeActiveSessionCronPaneKeys: new Set(),
    claudeLaunchedBackgroundTasksByPaneKey: new Map(),
    claudeConsumedCompactPromptIdByPaneKey: new Map(),
    claudeSessionOwnerByPaneKey: new Map(),
    hookRootAttempts: new Map(),
    codexSubagentRosterByPaneKey: new Map(),
    codexSubagentTranscriptByPaneKey: new Map(),
    codexLeadStateByPaneKey: new Map(),
    codexAsyncQuestionsByPaneKey: new Map(),
    codexEphemeralForkSessionsByPaneKey: new Map(),
    codexHeldEphemeralStartByPaneKey: new Map(),
    grokActiveTurnByPaneKey: new Map(),
    grokMainAgentStatusByPaneKey: new Map(),
    grokBackgroundTasksByPaneKey: new Map(),
    musePaneStateByPaneKey: new Map(),
    opencodeSessionPaneBySessionId: new Map(),
    lastLaunchTokenByPaneKey: new Map(),
    hermesTurnByPaneKey: new Map()
  }
  legacyStatusAdapterByState.set(state, adapter)
  return state
}

export function admitLegacyAgentStatus(
  state: HookListenerState,
  caller: AgentStatusLegacyIngressCaller,
  entry: AgentHookEventPayload,
  mode: AgentStatusLegacyAdmissionMode,
  options?: { moveToEnd?: boolean }
): boolean {
  return legacyStatusAdapter(state).admit(caller, mode, entry, options)
}

export function canAdmitLegacyAgentStatusEntry(
  state: HookListenerState,
  caller: AgentStatusLegacyIngressCaller,
  entry: AgentHookEventPayload,
  mode: AgentStatusLegacyAdmissionMode
): boolean {
  return legacyStatusAdapter(state).canAdmit(caller, mode, entry)
}

export function deleteLegacyAgentStatus(state: HookListenerState, paneKey: string): boolean {
  return legacyStatusAdapter(state).delete(paneKey)
}

export function clearLegacyAgentStatuses(state: HookListenerState): void {
  legacyStatusAdapter(state).clear()
}

export function moveLegacyAgentStatuses(
  state: HookListenerState,
  fromPaneKey: string,
  toPaneKey: string
): void {
  legacyStatusAdapter(state).move(fromPaneKey, toPaneKey)
}

export function getLegacyStatusListingOrder(
  state: HookListenerState,
  paneKey: string
): number | undefined {
  return legacyStatusAdapter(state).listingOrder(paneKey)
}

export function clearPaneCacheState(state: HookListenerState, paneKey: string): void {
  deletePaneScopedCacheEntry(state.lastPromptByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.lastToolByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.jcodeTurnPromptByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.jcodeHelperPermissionWaitByPaneKey, paneKey)
  deleteLegacyAgentStatus(state, paneKey)
  for (const key of state.lastStatusByPaneKey.keys()) {
    if (key.startsWith(`${paneKey}\0`)) {
      deleteLegacyAgentStatus(state, key)
    }
  }
  deletePaneScopedCacheEntry(state.antigravityCompletedTranscriptByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.antigravityChildWorkByPaneKey, paneKey)
  deletePaneScopedSetEntry(state.ampCompletedCacheKeys, paneKey)
  deletePaneScopedCacheEntry(state.claudeConsumedCompactPromptIdByPaneKey, paneKey)
  state.claudeSubagentRosterByPaneKey.delete(paneKey)
  state.claudeLeadStateByPaneKey.delete(paneKey)
  state.claudeOpenToolUsesByPaneKey.delete(paneKey)
  state.claudeUnconfirmedRestoredStatusPaneKeys.delete(paneKey)
  state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  state.claudeActiveSessionCronPaneKeys.delete(paneKey)
  state.claudeLaunchedBackgroundTasksByPaneKey.delete(paneKey)
  state.claudeSessionOwnerByPaneKey.delete(paneKey)
  state.codexSubagentRosterByPaneKey.delete(paneKey)
  state.codexSubagentTranscriptByPaneKey.delete(paneKey)
  state.codexLeadStateByPaneKey.delete(paneKey)
  state.codexAsyncQuestionsByPaneKey.delete(paneKey)
  state.codexEphemeralForkSessionsByPaneKey.delete(paneKey)
  state.codexHeldEphemeralStartByPaneKey.delete(paneKey)
  state.grokActiveTurnByPaneKey.delete(paneKey)
  state.grokMainAgentStatusByPaneKey.delete(paneKey)
  state.grokBackgroundTasksByPaneKey.delete(paneKey)
  state.musePaneStateByPaneKey.delete(paneKey)
  unbindOpenCodeSessionsOfPane(state, paneKey)
  deletePaneScopedCacheEntry(state.lastLaunchTokenByPaneKey, paneKey)
  state.hermesTurnByPaneKey.delete(paneKey)
  // A disposed pane's unfinished evidence and exit intent die with it.
  deletePaneScopedCacheEntry(state.hookRootAttempts, paneKey)
}

export function movePaneCacheState(
  state: HookListenerState,
  fromPaneKey: string,
  toPaneKey: string
): void {
  if (fromPaneKey === toPaneKey) {
    return
  }
  movePaneScopedMapEntries(state.lastPromptByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.lastToolByPaneKey, fromPaneKey, toPaneKey)
  moveLegacyAgentStatuses(state, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.antigravityCompletedTranscriptByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.antigravityChildWorkByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.jcodeTurnPromptByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.jcodeHelperPermissionWaitByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.ampCompletedCacheKeys, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeConsumedCompactPromptIdByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeSubagentRosterByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeLeadStateByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeOpenToolUsesByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.claudeUnconfirmedRestoredStatusPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.claudeRunningNonAgentTaskPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.claudeActiveSessionCronPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeLaunchedBackgroundTasksByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeSessionOwnerByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexSubagentRosterByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexSubagentTranscriptByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexLeadStateByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexAsyncQuestionsByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexEphemeralForkSessionsByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexHeldEphemeralStartByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.grokActiveTurnByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.grokMainAgentStatusByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.grokBackgroundTasksByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.musePaneStateByPaneKey, fromPaneKey, toPaneKey)
  moveOpenCodeSessionBindings(state, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.lastLaunchTokenByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.hermesTurnByPaneKey, fromPaneKey, toPaneKey)
}

export function clearPaneTurnCacheState(state: HookListenerState, paneKey: string): void {
  state.lastPromptByPaneKey.delete(paneKey)
  state.lastToolByPaneKey.delete(paneKey)
  state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  state.antigravityChildWorkByPaneKey.delete(paneKey)
  state.jcodeTurnPromptByPaneKey.delete(paneKey)
  state.ampCompletedCacheKeys.delete(paneKey)
  state.grokActiveTurnByPaneKey.delete(paneKey)
  state.grokMainAgentStatusByPaneKey.delete(paneKey)
  state.grokBackgroundTasksByPaneKey.delete(paneKey)
}

export function clearAllListenerCaches(state: HookListenerState): void {
  state.lastPromptByPaneKey.clear()
  state.lastToolByPaneKey.clear()
  clearLegacyAgentStatuses(state)
  state.antigravityCompletedTranscriptByPaneKey.clear()
  state.antigravityChildWorkByPaneKey.clear()
  state.jcodeTurnPromptByPaneKey.clear()
  state.jcodeHelperPermissionWaitByPaneKey.clear()
  state.ampCompletedCacheKeys.clear()
  state.claudeConsumedCompactPromptIdByPaneKey.clear()
  state.warnedVersions.clear()
  state.warnedEnvs.clear()
  state.claudeSubagentRosterByPaneKey.clear()
  state.claudeLeadStateByPaneKey.clear()
  state.claudeOpenToolUsesByPaneKey.clear()
  state.claudeUnconfirmedRestoredStatusPaneKeys.clear()
  state.claudeRunningNonAgentTaskPaneKeys.clear()
  state.claudeActiveSessionCronPaneKeys.clear()
  state.claudeLaunchedBackgroundTasksByPaneKey.clear()
  state.claudeSessionOwnerByPaneKey.clear()
  state.codexSubagentRosterByPaneKey.clear()
  state.codexSubagentTranscriptByPaneKey.clear()
  state.codexLeadStateByPaneKey.clear()
  state.codexAsyncQuestionsByPaneKey.clear()
  state.codexEphemeralForkSessionsByPaneKey.clear()
  state.codexHeldEphemeralStartByPaneKey.clear()
  state.grokActiveTurnByPaneKey.clear()
  state.grokMainAgentStatusByPaneKey.clear()
  state.grokBackgroundTasksByPaneKey.clear()
  state.musePaneStateByPaneKey.clear()
  state.opencodeSessionPaneBySessionId.clear()
  state.lastLaunchTokenByPaneKey.clear()
  state.hermesTurnByPaneKey.clear()
  state.hookRootAttempts.clear()
}
