import type { AgentMainAgentStatus, ParsedAgentStatusPayload } from '../../agent-status-types'
import {
  continueMainAgentStatus,
  foldAgentLeadStatus,
  mainAgentTurnInterrupted,
  type AgentLeadStatusResolution
} from '../../agent-lead-status-fold'
import {
  codexRosterChildWorkLiveness,
  codexRosterToSnapshots,
  finishCodexSubagent,
  seedCodexSubagentRoster,
  type CodexSubagentRoster
} from '../../codex-subagent-roster'
import {
  createCodexSubagentTranscriptState,
  hasTrackedCodexTranscriptSubagents,
  type CodexSubagentTranscriptState
} from '../../codex-subagent-transcript'
import type { CodexLeadTurnState, HookListenerState } from '../listener-state'

export function getOrCreateCodexSubagentRoster(
  state: HookListenerState,
  paneKey: string
): CodexSubagentRoster {
  let roster = state.codexSubagentRosterByPaneKey.get(paneKey)
  if (!roster) {
    roster = new Map()
    state.codexSubagentRosterByPaneKey.set(paneKey, roster)
  }
  return roster
}

export function getOrCreateCodexSubagentTranscriptState(
  state: HookListenerState,
  paneKey: string
): CodexSubagentTranscriptState {
  let transcriptState = state.codexSubagentTranscriptByPaneKey.get(paneKey)
  if (!transcriptState) {
    transcriptState = createCodexSubagentTranscriptState()
    state.codexSubagentTranscriptByPaneKey.set(paneKey, transcriptState)
  }
  return transcriptState
}

export function hasCodexTranscriptSubagents(state: HookListenerState, paneKey: string): boolean {
  return hasTrackedCodexTranscriptSubagents(state.codexSubagentTranscriptByPaneKey.get(paneKey))
}

/** The only writer of the root record; the root's clock keeps continuity across same-state writes. */
export function setCodexMainAgentTurnState(
  state: HookListenerState,
  paneKey: string,
  next: Omit<CodexLeadTurnState, 'stateStartedAt' | 'turnId'> & {
    stateStartedAt?: number
    /** Omitted keeps the current turn; null starts a turn Codex sent no id for. */
    turnId?: string | null
  },
  now = Date.now()
): CodexLeadTurnState {
  const previous = state.codexLeadStateByPaneKey.get(paneKey)
  const continued = continueMainAgentStatus(previous, next, now)
  const turnId = next.turnId === null ? undefined : (next.turnId ?? previous?.turnId)
  const sessionId = next.sessionId ?? previous?.sessionId
  const record: CodexLeadTurnState = {
    state: next.state,
    ...(continued.outcome ? { outcome: continued.outcome } : {}),
    stateStartedAt: continued.stateStartedAt,
    model: next.model,
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {})
  }
  state.codexLeadStateByPaneKey.set(paneKey, record)
  return record
}

/** Interrupt records cancellation; late Stops restate the ended turn's verdict until a new turn clears it. */
export function codexLeadOutcomeForEvent(
  eventName: unknown,
  previous: CodexLeadTurnState | undefined,
  nextState: CodexLeadTurnState['state']
): Pick<CodexLeadTurnState, 'outcome'> {
  if (eventName === 'Interrupt') {
    return { outcome: 'cancellation' }
  }
  return nextState === 'done' && previous?.state === 'done' && previous.outcome
    ? { outcome: previous.outcome }
    : {}
}

/** The combined row state for a Codex pane: the root record and its roster through the same
 *  fold every other lane uses. */
export function resolveCodexPaneStatus(
  state: HookListenerState,
  paneKey: string,
  record: Pick<CodexLeadTurnState, 'state'>
): AgentLeadStatusResolution {
  return foldAgentLeadStatus({
    leadState: record.state,
    childWorkLiveness: codexRosterChildWorkLiveness(state.codexSubagentRosterByPaneKey.get(paneKey))
  })
}

/** The `mainAgent` fact a Codex row publishes, straight from the root record. */
export function codexMainAgentStatusForPayload(
  record: CodexLeadTurnState | undefined
): AgentMainAgentStatus | undefined {
  return record
    ? {
        state: record.state,
        ...(record.state === 'done' && record.outcome ? { outcome: record.outcome } : {}),
        stateStartedAt: record.stateStartedAt
      }
    : undefined
}

export function seedCodexStateFromSnapshot(
  state: HookListenerState,
  paneKey: string,
  payload: Pick<ParsedAgentStatusPayload, 'model' | 'state' | 'subagents' | 'mainAgent'>
): void {
  const snapshots = payload.subagents ?? []
  if (snapshots.length > 0 && !state.codexSubagentRosterByPaneKey.has(paneKey)) {
    seedCodexSubagentRoster(getOrCreateCodexSubagentRoster(state, paneKey), snapshots)
  }
  if (!state.codexLeadStateByPaneKey.has(paneKey)) {
    const mainAgent = payload.mainAgent
    // Restarted relay child hooks lack root model; seed from durable mainAgent, inferring only for older rows.
    if (mainAgent && mainAgent.state !== 'blocked') {
      setCodexMainAgentTurnState(state, paneKey, {
        state: mainAgent.state,
        ...(mainAgent.outcome ? { outcome: mainAgent.outcome } : {}),
        stateStartedAt: mainAgent.stateStartedAt,
        model: payload.model
      })
      return
    }
    setCodexMainAgentTurnState(state, paneKey, {
      // Aggregate child waiting does not prove the root waited.
      state:
        payload.state === 'done'
          ? 'done'
          : payload.state === 'waiting' &&
              !snapshots.some((snapshot) => snapshot.state === 'waiting')
            ? 'waiting'
            : 'working',
      model: payload.model
    })
  }
}

/** Sync the Codex lead record when the server infers an interrupt, so delayed child events cannot restore stale working state. */
export function markCodexLeadTurnInterrupted(state: HookListenerState, paneKey: string): void {
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  setCodexMainAgentTurnState(state, paneKey, {
    state: 'done',
    outcome: 'cancellation',
    model: lead?.model
  })
}

export function codexLeadStateForHookEvent(
  eventName: string | undefined,
  normalizedState?: ParsedAgentStatusPayload['state']
): CodexLeadTurnState['state'] | undefined {
  if (eventName === 'Stop' || eventName === 'Interrupt') {
    return 'done'
  }
  if (eventName === 'PermissionRequest') {
    // Preserve execution-host reviewer ownership; event names alone would turn every relayed approval into waiting.
    return normalizedState === 'working' ? 'working' : 'waiting'
  }
  if (
    eventName === 'SessionStart' ||
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    return 'working'
  }
  return undefined
}

/** Why: relay restarts lose lead/roster state; merge child events into main's longer-lived cache. */
export function reconcileRemoteCodexState(
  state: HookListenerState,
  paneKey: string,
  eventName: string | undefined,
  agentId: string | undefined,
  payload: ParsedAgentStatusPayload,
  previous: ParsedAgentStatusPayload | undefined
): ParsedAgentStatusPayload {
  if (previous?.agentType === 'codex') {
    seedCodexStateFromSnapshot(state, paneKey, previous)
  } else {
    seedCodexStateFromSnapshot(state, paneKey, payload)
  }

  // Why: older relays send child identity without roster snapshots; keep their already-normalized aggregate authoritative.
  if (agentId && !payload.subagents && !state.codexSubagentRosterByPaneKey.has(paneKey)) {
    return payload
  }
  const roster = getOrCreateCodexSubagentRoster(state, paneKey)
  if (payload.subagents) {
    seedCodexSubagentRoster(roster, payload.subagents)
  }
  if (agentId) {
    if (eventName === 'SubagentStop') {
      finishCodexSubagent(roster, agentId)
    }
  } else {
    const leadState = codexLeadStateForHookEvent(eventName, payload.state)
    if (eventName === 'SessionStart' || (eventName === 'Stop' && !payload.subagents)) {
      roster.clear()
    }
    if (leadState) {
      const previousLead = state.codexLeadStateByPaneKey.get(paneKey)
      setCodexMainAgentTurnState(state, paneKey, {
        state: leadState,
        ...codexLeadOutcomeForEvent(eventName, previousLead, leadState),
        model: payload.model ?? previousLead?.model
      })
    }
  }

  if (!eventName && !agentId && payload.mainAgent && payload.mainAgent.state !== 'blocked') {
    if (payload.mainAgent.state === 'done' && !payload.subagents) {
      // Why: an unlabelled host turn end (failed or cancelled) reporting no children has none left.
      roster.clear()
    }
    setCodexMainAgentTurnState(state, paneKey, {
      ...payload.mainAgent,
      state: payload.mainAgent.state,
      model: payload.model ?? state.codexLeadStateByPaneKey.get(paneKey)?.model
    })
  }
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  if (!lead) {
    return payload
  }
  const resolution = resolveCodexPaneStatus(state, paneKey, lead)
  // Child hooks often omit root prompts; keep the last label across relay restarts.
  const prompt =
    agentId && payload.prompt.length === 0 && previous?.agentType === 'codex'
      ? previous.prompt
      : payload.prompt
  return {
    ...payload,
    prompt,
    state: resolution.stateName,
    workingMode: resolution.workingMode,
    interrupted:
      resolution.stateName === 'done' && mainAgentTurnInterrupted(lead) ? true : undefined,
    model: lead.model ?? payload.model,
    subagents: codexRosterToSnapshots(roster),
    // Why: main's cache outlives a relay restart, so it is the main agent fact for a relayed row too.
    mainAgent: codexMainAgentStatusForPayload(lead)
  }
}
