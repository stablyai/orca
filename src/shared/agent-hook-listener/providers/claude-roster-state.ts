import type {
  AgentMainAgentStatus,
  AgentStatusState,
  AgentSubagentSnapshot,
  AgentWorkingMode
} from '../../agent-status-types'
import { continueMainAgentStatus, mainAgentTurnInterrupted } from '../../agent-lead-status-fold'
import type { ClaudeSubagentRoster } from '../../claude-subagent-roster'
import type { AgentHookEventPayload } from '../listener-event'
import type { ClaudeLeadTurnState, HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'
import { resolveClaudePaneStatus } from './claude-pane-hold-evidence'
export {
  resolveClaudePaneStatus,
  type ClaudePaneStatusResolution
} from './claude-pane-hold-evidence'

/** Only attributable lead events may re-anchor ownership; unknown/child events void nothing. */
const CLAUDE_SESSION_OWNER_EVENTS: ReadonlySet<string> = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Elicitation',
  'ElicitationResult'
])

/** Session replacement voids prior conversation claims even without SessionEnd. Preserve live shells until fresh inventory/certified death, confirmed in-process teammates, and the lead record the caller overwrites. */
export function voidClaimsOfReplacedClaudeSession(
  state: HookListenerState,
  eventName: unknown,
  eventAgentId: string | undefined,
  paneKey: string,
  hookPayload: Record<string, unknown>
): void {
  if (
    eventAgentId !== undefined ||
    typeof eventName !== 'string' ||
    !CLAUDE_SESSION_OWNER_EVENTS.has(eventName)
  ) {
    return
  }
  // Ignored compact/unknown SessionStart must not advance ownership or hide the next real replacement.
  if (
    eventName === 'SessionStart' &&
    hookPayload['source'] !== 'startup' &&
    hookPayload['source'] !== 'resume' &&
    hookPayload['source'] !== 'clear'
  ) {
    return
  }
  const sessionId = readString(hookPayload, 'session_id')
  if (!sessionId) {
    return
  }
  const previousOwner = state.claudeSessionOwnerByPaneKey.get(paneKey)
  state.claudeSessionOwnerByPaneKey.set(paneKey, sessionId)
  if (previousOwner === undefined || previousOwner === sessionId) {
    return
  }
  // Compact restarts stay in-turn. If more compact-capable owner events are added, give them equivalent guards.
  if (eventName === 'SessionStart') {
    return
  }
  state.claudeActiveSessionCronPaneKeys.delete(paneKey)
  // Replaced conversations' owed notifications cannot reach the new one.
  state.claudeLaunchedBackgroundTasksByPaneKey.delete(paneKey)
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (!roster) {
    return
  }
  for (const [id, tracked] of roster) {
    if (tracked.confirmedTeammate !== true) {
      roster.delete(id)
    }
  }
  if (roster.size === 0) {
    state.claudeSubagentRosterByPaneKey.delete(paneKey)
  }
}

export function getOrCreateClaudeSubagentRoster(
  state: HookListenerState,
  paneKey: string
): ClaudeSubagentRoster {
  let roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (!roster) {
    roster = new Map()
    state.claudeSubagentRosterByPaneKey.set(paneKey, roster)
  }
  return roster
}

/** Only fresh inventory retires a reported shell; lead verdicts cannot override positive process evidence. */
export function updateClaudeRunningNonAgentTask(
  state: HookListenerState,
  paneKey: string,
  hasRunningNonAgentTask: boolean
): void {
  if (hasRunningNonAgentTask) {
    state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
  } else {
    state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  }
}

/** Keep same-state lead clocks continuous; explicit restored stash times take precedence. */
export function setClaudeMainAgentTurnState(
  state: HookListenerState,
  paneKey: string,
  next: Omit<ClaudeLeadTurnState, 'stateStartedAt'> & { stateStartedAt?: number },
  now = Date.now()
): ClaudeLeadTurnState {
  const previous = state.claudeLeadStateByPaneKey.get(paneKey)
  const { state: nextState, outcome, stateStartedAt, ...rest } = next
  const record: ClaudeLeadTurnState = {
    ...rest,
    ...continueMainAgentStatus(previous, { state: nextState, outcome, stateStartedAt }, now)
  }
  state.claudeLeadStateByPaneKey.set(paneKey, record)
  return record
}

/** Publish only observed lead facts, restoring child-displaced state; absent records fall back to aggregate state. */
export function claudeMainAgentStatusForPayload(
  record: ClaudeLeadTurnState
): AgentMainAgentStatus | undefined {
  const own = record.waitingAgentId !== undefined ? record.stateBeforeWait : record
  if (!own) {
    return undefined
  }
  return {
    state: own.state,
    ...(own.state === 'done' && own.outcome ? { outcome: own.outcome } : {}),
    stateStartedAt: own.stateStartedAt
  }
}

/** Record host-inferred local Ctrl+C cancellation; Claude emits no cancel hook and bare Esc is not inferred. Refold surviving children without retiring shells/crons/subagents so later hooks cannot resurrect the lead. */
export function markClaudeLeadTurnInterrupted(
  state: HookListenerState,
  paneKey: string
): ReturnType<typeof markClaudeLeadTurnDone> {
  return markClaudeLeadTurnDone(state, paneKey, 'cancellation')
}

/** End the lead turn without its Stop hook; an absent outcome is unknown, as on a plain Stop. */
export function markClaudeLeadTurnDone(
  state: HookListenerState,
  paneKey: string,
  outcome?: 'cancellation'
): {
  state: AgentStatusState
  workingMode?: AgentWorkingMode
  mainAgent?: AgentMainAgentStatus
  claudeTaskWakeupPending?: 'notification' | 'finishing-turn'
} {
  const record = setClaudeMainAgentTurnState(state, paneKey, { state: 'done', outcome })
  const resolved = resolveClaudePaneStatus(state, paneKey, record)
  const mainAgent = claudeMainAgentStatusForPayload(record)
  return {
    state: resolved.stateName,
    claudeTaskWakeupPending: resolved.claudeTaskWakeupPending,
    ...(resolved.workingMode ? { workingMode: resolved.workingMode } : {}),
    ...(mainAgent ? { mainAgent } : {})
  }
}

/** Rebuild a pane's working roster from a persisted snapshot; live activity confirms a seed, a complete task inventory may reap an unconfirmed one whose finish hook arrived while Orca was offline. */
export function seedClaudeSubagentRosterFromSnapshots(
  state: HookListenerState,
  paneKey: string,
  snapshots: readonly AgentSubagentSnapshot[]
): void {
  if (snapshots.length === 0 || state.claudeSubagentRosterByPaneKey.has(paneKey)) {
    return
  }
  const roster = getOrCreateClaudeSubagentRoster(state, paneKey)
  for (const snapshot of snapshots) {
    // Idle teammates lack confirmation after restart; restore working seeds only and require live events for idle rows.
    if (snapshot.state !== 'working') {
      continue
    }
    roster.set(snapshot.id, {
      state: 'working',
      startedAt: snapshot.startedAt,
      agentType: snapshot.agentType,
      description: snapshot.description,
      // Authoritative omission may reap phantom seeds whose finish hooks were lost offline.
      backgroundTasksAuthoritative: true,
      // Restored seeds are not confirmed live work in this runtime.
      restoredFromSnapshot: true
    })
  }
}

/** Restore settled leads only when persisted evidence explicitly excludes running shells; missing evidence must not falsely settle after restart. */
export function seedClaudeLeadTurnFromPersistedStatus(
  state: HookListenerState,
  paneKey: string,
  status: Pick<AgentHookEventPayload, 'payload' | 'claudeRunningNonAgentTask'>
): void {
  const mainAgent = status.payload.mainAgent
  // Why: a row old enough to lack `mainAgent` was mapped from its legacy child-only flag at hydrate.
  if (
    status.payload.agentType === 'claude' &&
    mainAgent?.state === 'done' &&
    status.claudeRunningNonAgentTask === false
  ) {
    setClaudeMainAgentTurnState(state, paneKey, {
      state: 'done',
      ...(mainAgent.outcome ? { outcome: mainAgent.outcome } : {}),
      stateStartedAt: mainAgent.stateStartedAt,
      ...(status.payload.turnCompletedAt !== undefined
        ? { turnCompletedAt: status.payload.turnCompletedAt }
        : {})
    })
    if (status.payload.prompt) {
      state.lastPromptByPaneKey.set(paneKey, status.payload.prompt)
    }
    if (status.payload.lastAssistantMessage) {
      state.lastToolByPaneKey.set(paneKey, {
        lastAssistantMessage: status.payload.lastAssistantMessage,
        lastAssistantMessageIsToolOutput: status.payload.lastAssistantMessageIsToolOutput
      })
    }
  }
}

/** Drop a child-owned waiting state when the child stops/idles, restoring the displaced lead state. */
export function clearClaudePendingWaitForAgent(
  state: HookListenerState,
  paneKey: string,
  ownsWait: (waitingAgentId: string) => boolean
): void {
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  if (lead?.state !== 'waiting' || !lead.waitingAgentId || !ownsWait(lead.waitingAgentId)) {
    return
  }
  setClaudeMainAgentTurnState(state, paneKey, lead.stateBeforeWait ?? { state: 'working' })
  const previousTool = state.lastToolByPaneKey.get(paneKey)
  state.lastToolByPaneKey.set(
    paneKey,
    previousTool?.lastAssistantMessage
      ? {
          lastAssistantMessage: previousTool.lastAssistantMessage,
          lastAssistantMessageIsToolOutput: previousTool.lastAssistantMessageIsToolOutput
        }
      : {}
  )
}

/** Infer answered questions from submit keystrokes; restore prior lead/working state, clear the card, then fold surviving children. */
export function clearClaudeAnsweredQuestionWait(
  state: HookListenerState,
  paneKey: string
): Pick<ClaudeLeadTurnState, 'state' | 'turnCompletedAt'> & {
  interrupted?: true
  workingMode?: AgentWorkingMode
  mainAgent?: AgentMainAgentStatus
  claudeTaskWakeupPending?: 'notification' | 'finishing-turn'
} {
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  const stash =
    lead?.state === 'waiting'
      ? (lead.stateBeforeWait ?? {
          state: 'working' as const,
          ...(lead.taskWakeupTurn ? { taskWakeupTurn: true as const } : {})
        })
      : { state: 'working' as const }
  const restored = setClaudeMainAgentTurnState(state, paneKey, { ...stash })
  const publishedMainAgent = claudeMainAgentStatusForPayload(restored)
  const previousTool = state.lastToolByPaneKey.get(paneKey)
  state.lastToolByPaneKey.set(
    paneKey,
    previousTool?.lastAssistantMessage
      ? {
          lastAssistantMessage: previousTool.lastAssistantMessage,
          lastAssistantMessageIsToolOutput: previousTool.lastAssistantMessageIsToolOutput
        }
      : {}
  )
  const resolved = resolveClaudePaneStatus(state, paneKey, restored)
  return {
    state: resolved.stateName,
    claudeTaskWakeupPending: resolved.claudeTaskWakeupPending,
    ...(resolved.workingMode ? { workingMode: resolved.workingMode } : {}),
    ...(mainAgentTurnInterrupted(restored) ? { interrupted: true as const } : {}),
    ...(restored.turnCompletedAt !== undefined
      ? { turnCompletedAt: restored.turnCompletedAt }
      : {}),
    ...(publishedMainAgent ? { mainAgent: publishedMainAgent } : {})
  }
}
