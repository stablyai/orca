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
  type CodexSubagentTranscriptState
} from '../../codex-subagent-transcript'
import type { CodexRolloutTurnEnd } from '../../codex-rollout-turn-lifecycle'
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

/** How Codex's rollout recorded this turn's end, if it has. */
export function codexRolloutTurnEnd(
  state: HookListenerState,
  paneKey: string,
  turnId: string
): CodexRolloutTurnEnd | undefined {
  return state.codexSubagentTranscriptByPaneKey.get(paneKey)?.mainTurns.ended.get(turnId)
}

/** The turn Codex's rollout shows open: started, with no end recorded yet. */
export function codexRolloutOpenTurnId(
  state: HookListenerState,
  paneKey: string
): string | undefined {
  return state.codexSubagentTranscriptByPaneKey.get(paneKey)?.mainTurns.openTurnId
}

/** The only writer of the root record; the root's clock keeps continuity across same-state writes.
 *  A turn ends once: when Codex aborts it (its Interrupt hook) or its rollout records the end, which
 *  settles the record for that turn. After that, a fact for an ended turn changes nothing, and a
 *  fact for any other turn is Codex working again, whether or not a prompt started it. A Stop
 *  alone is not the end: a Stop hook that blocks makes Codex continue the same turn. */
export function setCodexMainAgentTurnState(
  state: HookListenerState,
  paneKey: string,
  next: Omit<CodexLeadTurnState, 'stateStartedAt'> & { stateStartedAt?: number },
  now = Date.now()
): CodexLeadTurnState {
  const previous = state.codexLeadStateByPaneKey.get(paneKey)
  const recordedEnd =
    next.turnId !== undefined ? codexRolloutTurnEnd(state, paneKey, next.turnId) : undefined
  if (
    previous &&
    next.turnId !== undefined &&
    (previous.turnId === next.turnId
      ? previous.state === 'done' && previous.outcome === 'cancellation'
      : previous.turnId !== undefined && recordedEnd !== undefined)
  ) {
    return previous
  }
  const settled: Pick<CodexLeadTurnState, 'state' | 'outcome'> = recordedEnd
    ? {
        state: 'done',
        outcome: recordedEnd === 'interrupted' ? 'cancellation' : undefined
      }
    : next
  const continued = continueMainAgentStatus(
    previous,
    { ...settled, stateStartedAt: next.stateStartedAt },
    now
  )
  const record: CodexLeadTurnState = {
    state: settled.state,
    ...(continued.outcome ? { outcome: continued.outcome } : {}),
    stateStartedAt: continued.stateStartedAt,
    model: next.model,
    ...(next.turnId !== undefined ? { turnId: next.turnId } : {})
  }
  state.codexLeadStateByPaneKey.set(paneKey, record)
  return record
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
  payload: Pick<ParsedAgentStatusPayload, 'model' | 'state' | 'subagents' | 'mainAgent'>,
  options?: { inferMainAgent?: boolean }
): void {
  const snapshots = payload.subagents ?? []
  if (snapshots.length > 0 && !state.codexSubagentRosterByPaneKey.has(paneKey)) {
    seedCodexSubagentRoster(getOrCreateCodexSubagentRoster(state, paneKey), snapshots)
  }
  if (!state.codexLeadStateByPaneKey.has(paneKey)) {
    const mainAgent = payload.mainAgent
    // Why: child hooks after restart omit the root model; seed it from durable status before they can overwrite the cache.
    // A row that carries the root's own state is the fact; only an older row makes us infer it.
    if (mainAgent && mainAgent.state !== 'blocked') {
      setCodexMainAgentTurnState(state, paneKey, {
        state: mainAgent.state,
        ...(mainAgent.outcome ? { outcome: mainAgent.outcome } : {}),
        stateStartedAt: mainAgent.stateStartedAt,
        model: payload.model
      })
      return
    }
    if (options?.inferMainAgent === false) {
      return
    }
    setCodexMainAgentTurnState(state, paneKey, {
      // Why: a child wait drives the aggregate waiting state, so it is not evidence that the root itself was waiting.
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

/** The root record a relayed event implies when its row carries no `mainAgent` (a relay that lost
 *  its records to a restart publishes none for a child event). */
export function codexLeadStateForHookEvent(
  eventName: string | undefined,
  normalizedState?: ParsedAgentStatusPayload['state']
): CodexLeadTurnState['state'] | undefined {
  if (eventName === 'Stop' || eventName === 'Interrupt') {
    return 'done'
  }
  if (eventName === 'PermissionRequest') {
    // Why: the execution host's normalizer already ruled on whether this approval is human-owned
    // or reviewer-owned, reading the reviewer off that host's rollout (STA-7698). Re-deriving
    // 'waiting' from the event name here would discard that verdict for every relayed pane.
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

/** Why: relay restarts lose lead/roster state; merge child events into main's longer-lived cache.
 *  An event with no hook name is the relay's rollout observation, a restatement of its whole row. */
export function reconcileRemoteCodexState(
  state: HookListenerState,
  paneKey: string,
  eventName: string | undefined,
  agentId: string | undefined,
  payload: ParsedAgentStatusPayload,
  previous: ParsedAgentStatusPayload | undefined
): ParsedAgentStatusPayload {
  // Why: a child's event says nothing about the main agent, so a row it drove cannot seed one.
  const seedOptions = { inferMainAgent: agentId === undefined }
  if (previous?.agentType === 'codex') {
    seedCodexStateFromSnapshot(state, paneKey, previous, seedOptions)
  } else {
    seedCodexStateFromSnapshot(state, paneKey, payload, seedOptions)
  }

  // Why: older relays send child identity without roster snapshots; keep their already-normalized aggregate authoritative.
  if (agentId && !payload.subagents && !state.codexSubagentRosterByPaneKey.has(paneKey)) {
    return payload
  }
  const roster = getOrCreateCodexSubagentRoster(state, paneKey)
  if (eventName === undefined) {
    // Why: a relay's rollout observation carries no hook name and restates its whole roster.
    roster.clear()
  }
  if (payload.subagents) {
    seedCodexSubagentRoster(roster, payload.subagents)
  }
  if (agentId) {
    if (eventName === 'SubagentStop') {
      finishCodexSubagent(roster, agentId)
    }
  } else if (eventName === 'SessionStart' || (eventName === 'Stop' && !payload.subagents)) {
    // Why: the relay's root Stop carries its whole roster, so one with none means the relay tracks
    // none; the relay itself never drops a child on Stop.
    roster.clear()
  }
  const previousLead = state.codexLeadStateByPaneKey.get(paneKey)
  const mainAgent = payload.mainAgent
  if (mainAgent && mainAgent.state !== 'blocked') {
    // Why: the relay decided this from the raw hook and its own rollout (turn identity, a lost
    // Interrupt), which main never sees; main keeps a copy, on its own clock, to outlive a relay
    // restart.
    setCodexMainAgentTurnState(state, paneKey, {
      state: mainAgent.state,
      ...(mainAgent.outcome ? { outcome: mainAgent.outcome } : {}),
      model: payload.model ?? previousLead?.model
    })
  } else if (!agentId) {
    const leadState = codexLeadStateForHookEvent(eventName, payload.state)
    if (leadState) {
      setCodexMainAgentTurnState(state, paneKey, {
        state: leadState,
        ...(eventName === 'Interrupt' ? { outcome: 'cancellation' as const } : {}),
        model: payload.model ?? previousLead?.model
      })
    }
  }

  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  if (!lead && !agentId) {
    return payload
  }
  // Why: with no record of the main agent, a child's event leaves the children alone to drive the row.
  const resolution = resolveCodexPaneStatus(state, paneKey, lead ?? { state: 'done' })
  // Child lifecycle hooks commonly omit the root prompt. Preserve the last known
  // turn label while merging their roster/state so relay restarts do not blank it.
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
    model: lead?.model ?? payload.model,
    subagents: codexRosterToSnapshots(roster),
    // Why: after a relay restart a child event carries no `mainAgent`; main's copy fills it.
    mainAgent: codexMainAgentStatusForPayload(lead)
  }
}
