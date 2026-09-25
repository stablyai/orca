import type {
  AgentMainAgentStatus,
  AgentStatusState,
  AgentSubagentSnapshot,
  AgentWorkingMode
} from '../../agent-status-types'
import {
  continueMainAgentStatus,
  mainAgentTurnInterrupted,
  foldAgentLeadStatus,
  type AgentLeadStatusResolution
} from '../../agent-lead-status-fold'
import { agentChildWorkLivenessFromEvidence } from '../../agent-status-child-work-liveness'
import {
  claudeRosterHasWorkingSubagent,
  reapUnconfirmedRestoredClaudeSubagents,
  type ClaudeSubagentRoster
} from '../../claude-subagent-roster'
import type { AgentHookEventPayload } from '../listener-event'
import type { ClaudeLeadTurnState, HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'

/** Lead events that may re-anchor a pane's owning session. Allow-list, not a deny-list: a payload we
 *  can't attribute (unknown name, child event missing its agent_id) must void nothing. */
const CLAUDE_SESSION_OWNER_EVENTS: ReadonlySet<string> = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest'
])

/** A pane whose `session_id` changed is running a different conversation, so claims the previous one
 *  owned are void — the hook-independent backstop for /clear, relaunch and resume. Modern Claude
 *  emits SessionEnd on /clear, but Orca previously did not install it and older binaries emit none.
 *
 *  Voids only what the replaced session provably owned. Deliberately NOT voided:
 *  - `claudeRunningNonAgentTaskPaneKeys`: a background shell is an OS process that survives /clear,
 *    and the previous inventory is positive evidence it was running. Only a fresh inventory or a
 *    certified process death may retire it.
 *  - `confirmedTeammate` roster rows: persistent in-process teammates a lead replacement can't end.
 *  - `claudeLeadStateByPaneKey`: the caller's own fold overwrites it anyway. */
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
  // Compact/unknown SessionStart events are intentionally ignored by the status fold; do not let
  // them advance the owner anchor or the next real lead event will miss the replacement.
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
  // Why: a compact restart mints a SessionStart mid-turn under the same conversation; the existing
  // handler already fails closed on non-idle sources, and this must not undercut it. No other
  // allow-listed event carries a compact `trigger`, so SessionStart is the whole guard — if a
  // compact event is ever added to CLAUDE_SESSION_OWNER_EVENTS, re-derive one for it deliberately.
  if (eventName === 'SessionStart') {
    return
  }
  state.claudeActiveSessionCronPaneKeys.delete(paneKey)
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

/** The inventory is the only judge of a running shell: it retires the gate when it omits the
 *  shell, and nothing about how the main agent's turn ended may override what it positively reports. */
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

export type ClaudePaneStatusResolution = AgentLeadStatusResolution

/** The only writer of the main agent record. The main agent's clock keeps continuity across
 *  same-state writes; a caller restoring a stash passes the stashed instant and wins. */
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

/** The `mainAgent` fact a row publishes from its record: nothing invented, so a pane whose main
 *  agent was never observed publishes none and readers fall back to the combined `state`.
 *  A child-induced wait occupies the record but is child work, so the main agent is the state it displaced. */
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

export function resolveClaudePaneStatus(
  state: HookListenerState,
  paneKey: string,
  lead: Pick<ClaudeLeadTurnState, 'state'>
): ClaudePaneStatusResolution {
  return foldAgentLeadStatus({
    leadState: lead.state,
    childWorkLiveness: agentChildWorkLivenessFromEvidence({
      // A child's permission wait displaces the main agent record itself (`waitingAgentId`,
      // `stateBeforeWait`) instead of living on the roster, so the roster never carries one.
      hasWaitingChildWork: false,
      hasLiveAgentWork: claudeRosterHasWorkingSubagent(
        state.claudeSubagentRosterByPaneKey.get(paneKey)
      ),
      hasLiveNonAgentWork:
        state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
        state.claudeActiveSessionCronPaneKeys.has(paneKey)
    })
  })
}

/** The SERVER inferred a cancel of a LOCAL pane outside the hook stream (Ctrl+C with no Stop;
 *  current Claude sends no hook on a cancel, and a bare Esc is never inferred for Claude): record
 *  the main agent's verdict and fold it with the child work the turn left running, exactly as a
 *  Stop would be. This is the primary source of `mainAgent.outcome: 'cancellation'` in the CLI
 *  lane, and the record is what keeps a later child lifecycle event from resurrecting the
 *  cancelled main agent. Nothing here retires a shell, cron or subagent: they outlive the cancel
 *  and leave only when their inventory says so. */
export function markClaudeLeadTurnInterrupted(
  state: HookListenerState,
  paneKey: string
): { state: AgentStatusState; workingMode?: AgentWorkingMode; mainAgent?: AgentMainAgentStatus } {
  const record = setClaudeMainAgentTurnState(state, paneKey, {
    state: 'done',
    outcome: 'cancellation'
  })
  const resolved = resolveClaudePaneStatus(state, paneKey, record)
  const mainAgent = claudeMainAgentStatusForPayload(record)
  return {
    state: resolved.stateName,
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
    // Why: idle-teammate liveness can't be proven across a restart (its TeammateIdle confirmation is gone); only working seeds restore, and a live teammate re-earns its row via SubagentStart.
    if (snapshot.state !== 'working') {
      continue
    }
    roster.set(snapshot.id, {
      state: 'working',
      startedAt: snapshot.startedAt,
      agentType: snapshot.agentType,
      description: snapshot.description,
      // Why: the seed can be a phantom (child finished while Orca was down, SubagentStop lost); let a PRESENT background_tasks list omitting the id remove it, not gate the pane 'working' forever.
      backgroundTasksAuthoritative: true,
      // Why: an idle parent never emits that list, so the inventory reap alone can strand the seed; mark it for the liveness reap below.
      restoredFromSnapshot: true
    })
  }
}

/** Restore a settled main agent so its children's drain can still complete the row after a restart.
 *  A running shell's liveness is not restored, so only a row that says no shell ran is seeded; one
 *  that says nothing (rewritten without the fact) stays unseeded rather than falsely settling. */
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

/** Reap this pane's unconfirmed restored seeds because no live agent process backs
 *  the pane any more (its PTY died while Orca was down, so no finish hook could
 *  arrive). Callers must have proven the pane is LOCAL-launched — a remote/SSH
 *  agent runs on the far host and can never appear in a local process index.
 *  Returns whether the roster changed. */
export function reapRestoredClaudeSubagentsForDeadPane(
  state: HookListenerState,
  paneKey: string
): boolean {
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (!roster || !reapUnconfirmedRestoredClaudeSubagents(roster)) {
    return false
  }
  if (roster.size === 0) {
    state.claudeSubagentRosterByPaneKey.delete(paneKey)
  }
  return true
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

/** Clear an AskUserQuestion wait after the answer is typed (answering emits no hook event; the caller infers it from the submit keystroke). Restores the stashed pre-wait lead state or 'working', drops the cached card, and returns the pane state to emit (gated up to 'working' while children run). */
export function clearClaudeAnsweredQuestionWait(
  state: HookListenerState,
  paneKey: string
): Pick<ClaudeLeadTurnState, 'state' | 'turnCompletedAt'> & {
  interrupted?: true
  workingMode?: AgentWorkingMode
  mainAgent?: AgentMainAgentStatus
} {
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  const stash =
    lead?.state === 'waiting'
      ? (lead.stateBeforeWait ?? { state: 'working' as const })
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
    ...(resolved.workingMode ? { workingMode: resolved.workingMode } : {}),
    ...(mainAgentTurnInterrupted(restored) ? { interrupted: true as const } : {}),
    ...(restored.turnCompletedAt !== undefined
      ? { turnCompletedAt: restored.turnCompletedAt }
      : {}),
    ...(publishedMainAgent ? { mainAgent: publishedMainAgent } : {})
  }
}
