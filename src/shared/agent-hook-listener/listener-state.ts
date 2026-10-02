import type { AgentMainAgentStatus } from '../agent-status-types'
import type { ClaudeLeadTurnState, CodexLeadTurnState } from './main-agent-turn-state'

export type { ClaudeLeadTurnState, CodexLeadTurnState } from './main-agent-turn-state'
import {
  AGENT_STATUS_2A_CURRENT_PRODUCER_MODE,
  createAgentStatusLegacyAdapter,
  type AgentStatusLegacyAdapter,
  type AgentStatusLegacyAdapterOptions,
  type AgentStatusLegacyAdmissionMode
} from '../agent-status-legacy-adapter'
import type { AgentStatusLegacyIngressCaller } from '../agent-status-legacy-ingress-manifest'
import type { ClaudeSubagentRoster } from '../claude-subagent-roster'
import type { JsonlCursor } from '../codex-rollout-jsonl-cursor'
import type { CodexSubagentRoster } from '../codex-subagent-roster'
import type { CodexSubagentTranscriptState } from '../codex-subagent-transcript'
import type { MuseSessionLogState } from '../muse-session-log'
import type { AgentHookEventPayload, ToolSnapshot } from './listener-event'
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
  /** Read-only compatibility view. All writes pass through the isolated legacy adapter. */
  lastStatusByPaneKey: ReadonlyMap<string, AgentHookEventPayload>
  antigravityCompletedTranscriptByPaneKey: Map<string, string>
  ampCompletedCacheKeys: Set<string>
  /** Live subagents/teammates per Claude pane; survives turn boundaries since background children outlive the lead turn. */
  claudeSubagentRosterByPaneKey: Map<string, ClaudeSubagentRoster>
  /** Last state from the LEAD session's own events (subagent events carry agent_id, excluded), so a SubagentStop can re-emit pane status; `outcome` persists so the eventual done still carries it. Published on every row as `mainAgent`. */
  claudeLeadStateByPaneKey: Map<string, ClaudeLeadTurnState>
  /** One-normalization provenance marker for a status backed only by restored child state. */
  claudeUnconfirmedRestoredStatusPaneKeys: Set<string>
  /** Panes whose latest authoritative Claude task inventory still has running non-agent work. */
  claudeRunningNonAgentTaskPaneKeys: Set<string>
  /** Panes whose latest authoritative Claude cron inventory still has a scheduled job. */
  claudeActiveSessionCronPaneKeys: Set<string>
  /** Compact whose completion each pane already applied, so relay duplicates can't refresh the row. */
  claudeConsumedCompactPromptIdByPaneKey: Map<string, string>
  /** Claude `session_id` that last reported on the pane from a LEAD event. A different id means the
   *  conversation was replaced (/clear, relaunch, resume), so claims the old session owned are void
   *  even when no SessionStart arrives — the backstop for the exits that emit no terminating hook. */
  claudeSessionOwnerByPaneKey: Map<string, string>
  /** Claude session transcript read from where it ended when armed, only while the pane has working
   *  agent children; its `agents_killed` record is the CLI's only report that it killed them. */
  claudeAgentsKilledCursorByPaneKey: Map<string, JsonlCursor>
  /** Live thread-spawn children per Codex pane. */
  codexSubagentRosterByPaneKey: Map<string, CodexSubagentRoster>
  /** Incremental parent/child rollout cursors for Codex collaboration v2. */
  codexSubagentTranscriptByPaneKey: Map<string, CodexSubagentTranscriptState>
  /** Root Codex state/model, kept separate from child hook traffic. */
  codexLeadStateByPaneKey: Map<string, CodexLeadTurnState>
  /** Newest Grok turn per pane, used to reject end reports that arrive after a replacement prompt. */
  grokActiveTurnByPaneKey: Map<string, GrokActiveTurn>
  /** The Grok main agent's own state as last published, so its clock keeps continuity across events. */
  grokMainAgentStatusByPaneKey: Map<string, AgentMainAgentStatus>
  /** Muse child-session filter and session-log cursor per pane. */
  musePaneStateByPaneKey: Map<string, MusePaneState>
  /**
   * OpenCode session id -> owning pane, observed from the client side. The
   * shared v2 server stamps every post with its own frozen pane, so ingest
   * reattributes bound sessions before disposition. Not a state claim itself —
   * it names no row — so paneHasStateClaims ignores it.
   */
  opencodeSessionPaneBySessionId: Map<string, OpenCodeSessionBinding>
  /** Last launch token seen per pane; a rewritten shared-server post needs the bound pane's live token to pass its fence. */
  lastLaunchTokenByPaneKey: Map<string, string>
}

export type MusePaneState = {
  /** Internal reminder/subagent sessions; their hooks inherit the pane env and fire even after Stop. */
  childSessionIds: Set<string>
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
    lastStatusByPaneKey: adapter.view,
    antigravityCompletedTranscriptByPaneKey: new Map(),
    ampCompletedCacheKeys: new Set(),
    claudeSubagentRosterByPaneKey: new Map(),
    claudeLeadStateByPaneKey: new Map(),
    claudeUnconfirmedRestoredStatusPaneKeys: new Set(),
    claudeRunningNonAgentTaskPaneKeys: new Set(),
    claudeActiveSessionCronPaneKeys: new Set(),
    claudeConsumedCompactPromptIdByPaneKey: new Map(),
    claudeSessionOwnerByPaneKey: new Map(),
    claudeAgentsKilledCursorByPaneKey: new Map(),
    codexSubagentRosterByPaneKey: new Map(),
    codexSubagentTranscriptByPaneKey: new Map(),
    codexLeadStateByPaneKey: new Map(),
    grokActiveTurnByPaneKey: new Map(),
    grokMainAgentStatusByPaneKey: new Map(),
    musePaneStateByPaneKey: new Map(),
    opencodeSessionPaneBySessionId: new Map(),
    lastLaunchTokenByPaneKey: new Map()
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

/** Test harnesses seed the same compatibility region without exposing a mutable Map. */
export function seedLegacyAgentStatusForTests(
  state: HookListenerState,
  entry: AgentHookEventPayload
): void {
  if (
    !admitLegacyAgentStatus(
      state,
      'main-status-update',
      entry,
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
    )
  ) {
    throw new Error('Test legacy agent-status seed was refused')
  }
}

export function clearPaneCacheState(state: HookListenerState, paneKey: string): void {
  deletePaneScopedCacheEntry(state.lastPromptByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.lastToolByPaneKey, paneKey)
  deleteLegacyAgentStatus(state, paneKey)
  for (const key of state.lastStatusByPaneKey.keys()) {
    if (key.startsWith(`${paneKey}\0`)) {
      deleteLegacyAgentStatus(state, key)
    }
  }
  deletePaneScopedCacheEntry(state.antigravityCompletedTranscriptByPaneKey, paneKey)
  deletePaneScopedSetEntry(state.ampCompletedCacheKeys, paneKey)
  deletePaneScopedCacheEntry(state.claudeConsumedCompactPromptIdByPaneKey, paneKey)
  state.claudeSubagentRosterByPaneKey.delete(paneKey)
  state.claudeLeadStateByPaneKey.delete(paneKey)
  state.claudeUnconfirmedRestoredStatusPaneKeys.delete(paneKey)
  state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  state.claudeActiveSessionCronPaneKeys.delete(paneKey)
  state.claudeSessionOwnerByPaneKey.delete(paneKey)
  state.claudeAgentsKilledCursorByPaneKey.delete(paneKey)
  state.codexSubagentRosterByPaneKey.delete(paneKey)
  state.codexSubagentTranscriptByPaneKey.delete(paneKey)
  state.codexLeadStateByPaneKey.delete(paneKey)
  state.grokActiveTurnByPaneKey.delete(paneKey)
  state.grokMainAgentStatusByPaneKey.delete(paneKey)
  state.musePaneStateByPaneKey.delete(paneKey)
  unbindOpenCodeSessionsOfPane(state, paneKey)
  deletePaneScopedCacheEntry(state.lastLaunchTokenByPaneKey, paneKey)
}

/** Does this pane still hold anything that can ASSERT a state — a stored row, or a Claude latch that
 *  `resolveClaudePaneStatus` would re-gate `working` from on the pane's next event?
 *
 *  Deliberately lives next to `clearPaneCacheState` above and enumerates the claim-bearing subset of
 *  what that function deletes: the two must be edited together, and keeping them three lines apart in
 *  one file is what makes that obvious. Prompt/tool/transcript caches are excluded — they render a
 *  row, they never create one. */
export function paneHasStateClaims(state: HookListenerState, paneKey: string): boolean {
  return (
    state.lastStatusByPaneKey.has(paneKey) ||
    state.claudeSubagentRosterByPaneKey.has(paneKey) ||
    state.claudeLeadStateByPaneKey.has(paneKey) ||
    state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
    state.claudeActiveSessionCronPaneKeys.has(paneKey) ||
    state.claudeSessionOwnerByPaneKey.has(paneKey) ||
    state.codexSubagentRosterByPaneKey.has(paneKey) ||
    state.codexLeadStateByPaneKey.has(paneKey)
  )
}

export function movePaneScopedMapEntries<T>(
  map: Map<string, T>,
  fromPaneKey: string,
  toPaneKey: string
): void {
  for (const [key, value] of Array.from(map.entries())) {
    if (key !== fromPaneKey && !key.startsWith(`${fromPaneKey}\0`)) {
      continue
    }
    map.delete(key)
    map.set(`${toPaneKey}${key.slice(fromPaneKey.length)}`, value)
  }
}

export function movePaneScopedSetEntries(
  set: Set<string>,
  fromPaneKey: string,
  toPaneKey: string
): void {
  for (const key of Array.from(set)) {
    if (key !== fromPaneKey && !key.startsWith(`${fromPaneKey}\0`)) {
      continue
    }
    set.delete(key)
    set.add(`${toPaneKey}${key.slice(fromPaneKey.length)}`)
  }
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
  movePaneScopedSetEntries(state.ampCompletedCacheKeys, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeConsumedCompactPromptIdByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeSubagentRosterByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeLeadStateByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.claudeUnconfirmedRestoredStatusPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.claudeRunningNonAgentTaskPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.claudeActiveSessionCronPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeSessionOwnerByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeAgentsKilledCursorByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexSubagentRosterByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexSubagentTranscriptByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexLeadStateByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.grokActiveTurnByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.grokMainAgentStatusByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.musePaneStateByPaneKey, fromPaneKey, toPaneKey)
  moveOpenCodeSessionBindings(state, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.lastLaunchTokenByPaneKey, fromPaneKey, toPaneKey)
}

export function clearPaneTurnCacheState(state: HookListenerState, paneKey: string): void {
  state.lastPromptByPaneKey.delete(paneKey)
  state.lastToolByPaneKey.delete(paneKey)
  state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  state.ampCompletedCacheKeys.delete(paneKey)
  state.grokActiveTurnByPaneKey.delete(paneKey)
  state.grokMainAgentStatusByPaneKey.delete(paneKey)
}

export function deletePaneScopedCacheEntry(map: Map<string, unknown>, paneKey: string): void {
  map.delete(paneKey)
  const scopedPrefix = `${paneKey}\0`
  for (const key of map.keys()) {
    if (key.startsWith(scopedPrefix)) {
      map.delete(key)
    }
  }
}

export function deletePaneScopedSetEntry(set: Set<string>, paneKey: string): void {
  set.delete(paneKey)
  const scopedPrefix = `${paneKey}\0`
  for (const key of set) {
    if (key.startsWith(scopedPrefix)) {
      set.delete(key)
    }
  }
}

export function clearAllListenerCaches(state: HookListenerState): void {
  state.lastPromptByPaneKey.clear()
  state.lastToolByPaneKey.clear()
  clearLegacyAgentStatuses(state)
  state.antigravityCompletedTranscriptByPaneKey.clear()
  state.ampCompletedCacheKeys.clear()
  state.claudeConsumedCompactPromptIdByPaneKey.clear()
  state.warnedVersions.clear()
  state.warnedEnvs.clear()
  state.claudeSubagentRosterByPaneKey.clear()
  state.claudeLeadStateByPaneKey.clear()
  state.claudeUnconfirmedRestoredStatusPaneKeys.clear()
  state.claudeRunningNonAgentTaskPaneKeys.clear()
  state.claudeActiveSessionCronPaneKeys.clear()
  state.claudeSessionOwnerByPaneKey.clear()
  state.claudeAgentsKilledCursorByPaneKey.clear()
  state.codexSubagentRosterByPaneKey.clear()
  state.codexSubagentTranscriptByPaneKey.clear()
  state.codexLeadStateByPaneKey.clear()
  state.grokActiveTurnByPaneKey.clear()
  state.grokMainAgentStatusByPaneKey.clear()
  state.opencodeSessionPaneBySessionId.clear()
  state.lastLaunchTokenByPaneKey.clear()
}
