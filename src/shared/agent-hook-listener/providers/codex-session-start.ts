import { normalizeAgentStatusPayload } from '../../agent-status/contracts/agent-status-types'
import { sameAgentStatusTerminalOwner } from '../../agent-status/identity/agent-status-terminal-owner'
import type { AgentLeadStatusResolution } from '../../agent-status/lifecycle/agent-lead-status-fold'
import { codexRosterToSnapshots } from '../../codex-subagent-roster'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import {
  codexMainAgentStatusForPayload,
  reconcileRemoteCodexState,
  resolveCodexPaneStatus,
  seedCodexStateFromSnapshot,
  setCodexMainAgentTurnState,
  type CodexRemoteRosterAuthority
} from './codex-state'

function clearCodexSessionState(state: HookListenerState, paneKey: string): void {
  state.codexSubagentRosterByPaneKey.delete(paneKey)
  state.codexSubagentTranscriptByPaneKey.delete(paneKey)
  state.codexLeadStateByPaneKey.delete(paneKey)
}

export function applyCodexSessionStart(
  state: HookListenerState,
  paneKey: string,
  start: { sessionId?: string; source?: string; agentId?: string; model?: string }
): (AgentLeadStatusResolution & { updateLead: boolean; sessionBoundary?: true }) | null {
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  if (
    start.agentId ||
    (start.sessionId && state.codexSubagentRosterByPaneKey.get(paneKey)?.has(start.sessionId))
  ) {
    return null
  }
  const idleSource =
    start.source === 'startup' ||
    start.source === 'resume' ||
    start.source === 'clear' ||
    start.source === 'fork'
  // Compaction and unknown starts restate existing work, never open a turn.
  if (start.source === 'compact' || (!idleSource && lead && lead.state !== 'done')) {
    const record =
      lead ??
      setCodexMainAgentTurnState(state, paneKey, {
        state: 'done',
        sessionId: start.sessionId,
        model: start.model
      })
    const resolution = resolveCodexPaneStatus(state, paneKey, record)
    return {
      ...resolution,
      updateLead: false,
      ...(resolution.stateName === 'done' ? { sessionBoundary: true } : {})
    }
  }
  clearCodexSessionState(state, paneKey)
  setCodexMainAgentTurnState(state, paneKey, {
    state: 'done',
    sessionId: start.sessionId,
    model: start.model
  })
  return { stateName: 'done', updateLead: true, sessionBoundary: true }
}

/** Correct session-only evidence before an older relay's working payload can seed the root. */
export function reconcileCodexStatusEvent(
  state: HookListenerState,
  event: AgentHookEventPayload,
  previous: (AgentHookEventPayload & { stateStartedAt?: number }) | undefined,
  remoteRosterAuthority?: CodexRemoteRosterAuthority
): AgentHookEventPayload | null {
  if (
    (!event.connectionId && event.hookEventName) ||
    event.payload.agentType !== 'codex' ||
    (!event.hookEventName && !event.payload.mainAgent)
  ) {
    return event
  }
  const replayedStart = event.hookEventName === 'SessionStart' && event.isReplay === true
  if (
    replayedStart &&
    previous?.payload.agentType === 'codex' &&
    previous.providerSession?.id &&
    previous.providerSession.id === event.providerSession?.id &&
    sameAgentStatusTerminalOwner(previous, event)
  ) {
    // The accepted row can include a desktop-inferred end that the cached host never saw.
    const oldLead = state.codexLeadStateByPaneKey.get(event.paneKey)
    state.codexLeadStateByPaneKey.delete(event.paneKey)
    state.codexSubagentRosterByPaneKey.delete(event.paneKey)
    seedCodexStateFromSnapshot(state, event.paneKey, previous.payload)
    const lead = state.codexLeadStateByPaneKey.get(event.paneKey)!
    setCodexMainAgentTurnState(state, event.paneKey, {
      ...lead,
      stateStartedAt:
        previous.payload.mainAgent?.stateStartedAt ??
        previous.stateStartedAt ??
        oldLead?.stateStartedAt,
      sessionId: previous.providerSession.id,
      turnId: oldLead?.sessionId === previous.providerSession.id ? oldLead.turnId : null
    })
    return previous
  }
  if (replayedStart) {
    clearCodexSessionState(state, event.paneKey)
  }
  const unconfirmedRoot =
    replayedStart ||
    (previous?.restoredUnconfirmed &&
      (event.hookEventName === 'SessionStart' || event.toolAgentId !== undefined))
  if (
    event.hookEventName === 'SessionStart' &&
    ((!event.isReplay && !event.hasExplicitPrompt) || (event.isReplay && !event.payload.mainAgent))
  ) {
    const codexPrevious = previous?.payload.agentType === 'codex'
    if (!codexPrevious) {
      clearCodexSessionState(state, event.paneKey)
    } else {
      seedCodexStateFromSnapshot(state, event.paneKey, previous.payload)
      const lead = state.codexLeadStateByPaneKey.get(event.paneKey)!
      setCodexMainAgentTurnState(state, event.paneKey, {
        ...lead,
        sessionId: previous.providerSession?.id
      })
    }
    const normalizedIdle = event.payload.mainAgent?.state === 'done'
    const start = applyCodexSessionStart(state, event.paneKey, {
      sessionId: event.providerSession?.id,
      agentId: event.toolAgentId,
      source:
        normalizedIdle && event.providerSession?.id === previous?.providerSession?.id
          ? 'compact'
          : event.payload.sessionBoundary
            ? 'startup'
            : undefined,
      model: event.payload.model
    })
    if (!start) {
      return null
    }
    if (normalizedIdle) {
      // A corrected host owns its idle verdict and complete child snapshot, including after compact.
      state.codexSubagentRosterByPaneKey.delete(event.paneKey)
      return {
        ...event,
        restoredUnconfirmed: unconfirmedRoot ? true : undefined,
        payload: reconcileRemoteCodexState(
          state,
          event.paneKey,
          undefined,
          event.toolAgentId,
          event.payload,
          undefined,
          remoteRosterAuthority
        )
      }
    }
    const lead = state.codexLeadStateByPaneKey.get(event.paneKey)
    return {
      ...event,
      restoredUnconfirmed: unconfirmedRoot ? true : undefined,
      payload: normalizeAgentStatusPayload({
        ...(start.updateLead ? {} : previous?.payload),
        state: start.stateName,
        workingMode: start.workingMode,
        agentType: 'codex',
        prompt: start.updateLead ? '' : (previous?.payload.prompt ?? ''),
        model: lead?.model,
        sessionBoundary: start.sessionBoundary,
        mainAgent: codexMainAgentStatusForPayload(lead),
        subagents: codexRosterToSnapshots(state.codexSubagentRosterByPaneKey.get(event.paneKey))
      })!
    }
  }
  const replacement =
    event.hookEventName === 'SessionStart' &&
    event.hasExplicitPrompt &&
    !event.isReplay &&
    event.providerSession?.id !== previous?.providerSession?.id
  if (replacement) {
    clearCodexSessionState(state, event.paneKey)
    setCodexMainAgentTurnState(state, event.paneKey, {
      state: 'working',
      sessionId: event.providerSession?.id,
      model: event.payload.model
    })
  }
  return {
    ...event,
    restoredUnconfirmed: unconfirmedRoot ? true : undefined,
    payload: reconcileRemoteCodexState(
      state,
      event.paneKey,
      event.hookEventName === 'SessionStart'
        ? event.isReplay
          ? undefined
          : 'UserPromptSubmit'
        : event.hookEventName,
      event.toolAgentId,
      event.payload,
      replacement ? undefined : previous?.payload,
      remoteRosterAuthority
    )
  }
}
