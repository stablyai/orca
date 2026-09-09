import type { AgentStatusState } from '../agent-status-types'
import type { ClaudeSubagentRoster } from '../claude-subagent-roster'
import type { CodexSubagentRoster } from '../codex-subagent-roster'
import type { CodexSubagentTranscriptState } from '../codex-subagent-transcript'
import type { AgentHookEventPayload, ToolSnapshot } from './listener-event'

/** Per-listener-instance caches needing per-PTY teardown; Orca's main process and the relay each get their own, never shared. */
export type HookListenerState = {
  warnedVersions: Set<string>
  warnedEnvs: Set<string>
  lastPromptByPaneKey: Map<string, string>
  lastToolByPaneKey: Map<string, ToolSnapshot>
  lastStatusByPaneKey: Map<string, AgentHookEventPayload>
  antigravityCompletedTranscriptByPaneKey: Map<string, string>
  ampCompletedCacheKeys: Set<string>
  /** Live subagents/teammates per Claude pane; survives turn boundaries since background children outlive the lead turn. */
  claudeSubagentRosterByPaneKey: Map<string, ClaudeSubagentRoster>
  /** Last state from the LEAD session's own events (subagent events carry agent_id, excluded), so a SubagentStop can re-emit pane status; `interrupted` persists so the eventual done still carries it. */
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
  /** Live thread-spawn children per Codex pane. */
  codexSubagentRosterByPaneKey: Map<string, CodexSubagentRoster>
  /** Incremental parent/child rollout cursors for Codex collaboration v2. */
  codexSubagentTranscriptByPaneKey: Map<string, CodexSubagentTranscriptState>
  /** Root Codex state/model, kept separate from child hook traffic. */
  codexLeadStateByPaneKey: Map<string, CodexLeadTurnState>
}

export type ClaudeLeadTurnState = {
  state: AgentStatusState
  interrupted?: true
  /** Subagent that induced the wait; only its next tool activity may clear it, so other children's churn can't dismiss a pending human-input card. */
  waitingAgentId?: string
  /** Tool call that owns the wait; late completions from parallel sibling tools must not dismiss its card. */
  waitingToolUseId?: string
  /** End time of the lead turn closed while background inventory kept the pane `working`. Repeated on the later all-clear `done`. */
  turnCompletedAt?: number
  /** Lead state a child-induced wait displaced, restored when the wait clears; can't invent 'working' since the done-gate only downgrades done→working, never back. */
  stateBeforeWait?: Pick<ClaudeLeadTurnState, 'state' | 'interrupted' | 'turnCompletedAt'>
}

export type CodexLeadTurnState = {
  state: 'working' | 'waiting' | 'done'
  model?: string
}

export function createHookListenerState(): HookListenerState {
  return {
    warnedVersions: new Set(),
    warnedEnvs: new Set(),
    lastPromptByPaneKey: new Map(),
    lastToolByPaneKey: new Map(),
    lastStatusByPaneKey: new Map(),
    antigravityCompletedTranscriptByPaneKey: new Map(),
    ampCompletedCacheKeys: new Set(),
    claudeSubagentRosterByPaneKey: new Map(),
    claudeLeadStateByPaneKey: new Map(),
    claudeUnconfirmedRestoredStatusPaneKeys: new Set(),
    claudeRunningNonAgentTaskPaneKeys: new Set(),
    claudeActiveSessionCronPaneKeys: new Set(),
    claudeConsumedCompactPromptIdByPaneKey: new Map(),
    claudeSessionOwnerByPaneKey: new Map(),
    codexSubagentRosterByPaneKey: new Map(),
    codexSubagentTranscriptByPaneKey: new Map(),
    codexLeadStateByPaneKey: new Map()
  }
}

export function clearPaneCacheState(state: HookListenerState, paneKey: string): void {
  deletePaneScopedCacheEntry(state.lastPromptByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.lastToolByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.lastStatusByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.antigravityCompletedTranscriptByPaneKey, paneKey)
  deletePaneScopedSetEntry(state.ampCompletedCacheKeys, paneKey)
  deletePaneScopedCacheEntry(state.claudeConsumedCompactPromptIdByPaneKey, paneKey)
  state.claudeSubagentRosterByPaneKey.delete(paneKey)
  state.claudeLeadStateByPaneKey.delete(paneKey)
  state.claudeUnconfirmedRestoredStatusPaneKeys.delete(paneKey)
  state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  state.claudeActiveSessionCronPaneKeys.delete(paneKey)
  state.claudeSessionOwnerByPaneKey.delete(paneKey)
  state.codexSubagentRosterByPaneKey.delete(paneKey)
  state.codexSubagentTranscriptByPaneKey.delete(paneKey)
  state.codexLeadStateByPaneKey.delete(paneKey)
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
  movePaneScopedMapEntries(state.lastStatusByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.antigravityCompletedTranscriptByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.ampCompletedCacheKeys, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeConsumedCompactPromptIdByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeSubagentRosterByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeLeadStateByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.claudeUnconfirmedRestoredStatusPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.claudeRunningNonAgentTaskPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.claudeActiveSessionCronPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeSessionOwnerByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexSubagentRosterByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexSubagentTranscriptByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexLeadStateByPaneKey, fromPaneKey, toPaneKey)
}

export function clearPaneTurnCacheState(state: HookListenerState, paneKey: string): void {
  state.lastPromptByPaneKey.delete(paneKey)
  state.lastToolByPaneKey.delete(paneKey)
  state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  state.ampCompletedCacheKeys.delete(paneKey)
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
  state.lastStatusByPaneKey.clear()
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
  state.codexSubagentRosterByPaneKey.clear()
  state.codexSubagentTranscriptByPaneKey.clear()
  state.codexLeadStateByPaneKey.clear()
}
