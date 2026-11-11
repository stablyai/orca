import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status/contracts/agent-status-types'
import {
  sameAgentStatusSessionOwner,
  sameAgentStatusTerminalOwner
} from '../../agent-status/identity/agent-status-terminal-owner'
import type { AgentLeadStatusResolution } from '../../agent-status/lifecycle/agent-lead-status-fold'
import { codexRosterToSnapshots, type CodexSubagentRoster } from '../../codex-subagent-roster'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { codexResumedTurn } from './codex-resumed-turn'
import {
  codexMainAgentStatusForPayload,
  reconcileRemoteCodexState,
  resolveCodexPaneStatus,
  seedCodexStateFromSnapshot,
  setCodexMainAgentTurnState,
  type CodexRemoteRosterAuthority
} from './codex-state'

/** Only a definite root replacement excludes an execution host's previous turn facts. */
export function previousCodexTurnContext<T extends AgentHookEventPayload>(
  previous: T | undefined,
  event: AgentHookEventPayload
): T | undefined {
  return event.payload.agentType === 'codex' &&
    event.hookEventName === 'SessionStart' &&
    event.toolAgentId === undefined &&
    event.providerSessionOnly !== true &&
    (previous?.payload.agentType !== 'codex' || !sameAgentStatusSessionOwner(previous, event))
    ? undefined
    : previous
}

function clearCodexSessionState(state: HookListenerState, paneKey: string): void {
  state.codexAsyncQuestionsByPaneKey.delete(paneKey)
  state.codexSubagentRosterByPaneKey.delete(paneKey)
  state.codexSubagentTranscriptByPaneKey.delete(paneKey)
  state.codexLeadStateByPaneKey.delete(paneKey)
}

function isCodexChildSessionStart(
  start: { sessionId?: string; agentId?: string },
  roster: CodexSubagentRoster | undefined,
  snapshot?: ParsedAgentStatusPayload
): boolean {
  return Boolean(
    start.agentId ||
    (start.sessionId &&
      (roster?.has(start.sessionId) ??
        snapshot?.subagents?.some((child) => child.id === start.sessionId)))
  )
}

export function applyCodexSessionStart(
  state: HookListenerState,
  paneKey: string,
  start: { sessionId?: string; source?: string; agentId?: string; model?: string }
): (AgentLeadStatusResolution & { updateLead: boolean; sessionBoundary?: true }) | null {
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  if (isCodexChildSessionStart(start, state.codexSubagentRosterByPaneKey.get(paneKey))) {
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
  const resumed = codexResumedTurn(state, event, previous)
  if (resumed) {
    return resumed
  }
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
  let context = previous
  if (event.hookEventName === 'SessionStart' && (replayedStart || !event.hasExplicitPrompt)) {
    const sameOwner =
      previous?.payload.agentType === 'codex' && sameAgentStatusTerminalOwner(previous, event)
    const roster = sameOwner ? state.codexSubagentRosterByPaneKey.get(event.paneKey) : undefined
    const sessionId = event.providerSession?.id
    // Classify children before releasing the previous root's roster.
    if (
      isCodexChildSessionStart(
        { sessionId, agentId: event.toolAgentId },
        roster,
        sameOwner ? previous.payload : undefined
      )
    ) {
      return null
    }
    if (
      replayedStart ||
      previous?.payload.agentType !== 'codex' ||
      !sameAgentStatusSessionOwner(previous, event)
    ) {
      clearCodexSessionState(state, event.paneKey)
      context = undefined
    }
  }
  const unconfirmedRoot =
    replayedStart ||
    (context?.restoredUnconfirmed &&
      (event.hookEventName === 'SessionStart' || event.toolAgentId !== undefined))
  if (
    event.hookEventName === 'SessionStart' &&
    ((!event.isReplay && !event.hasExplicitPrompt) || (event.isReplay && !event.payload.mainAgent))
  ) {
    if (context?.payload.agentType !== 'codex') {
      clearCodexSessionState(state, event.paneKey)
    } else {
      seedCodexStateFromSnapshot(state, event.paneKey, context.payload)
      const lead = state.codexLeadStateByPaneKey.get(event.paneKey)!
      setCodexMainAgentTurnState(state, event.paneKey, {
        ...lead,
        sessionId: context.providerSession?.id
      })
    }
    const normalizedIdle = event.payload.mainAgent?.state === 'done'
    const start = applyCodexSessionStart(state, event.paneKey, {
      sessionId: event.providerSession?.id,
      agentId: event.toolAgentId,
      source:
        normalizedIdle && event.providerSession?.id === context?.providerSession?.id
          ? 'compact'
          : event.payload.sessionBoundary
            ? 'startup'
            : undefined,
      model: event.payload.model
    })
    if (!start) {
      return null
    }
    if (normalizedIdle || (replayedStart && !event.payload.mainAgent)) {
      // Cached children describe their own work; an absent root is only session identity.
      const snapshot = normalizedIdle
        ? event.payload
        : {
            ...event.payload,
            state: start.stateName,
            sessionBoundary: start.sessionBoundary,
            mainAgent: codexMainAgentStatusForPayload(
              state.codexLeadStateByPaneKey.get(event.paneKey)
            )
          }
      state.codexSubagentRosterByPaneKey.delete(event.paneKey)
      return {
        ...event,
        restoredUnconfirmed: unconfirmedRoot ? true : undefined,
        payload: reconcileRemoteCodexState(
          state,
          event.paneKey,
          undefined,
          event.toolAgentId,
          snapshot,
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
        ...(start.updateLead ? {} : context?.payload),
        state: start.stateName,
        workingMode: start.workingMode,
        agentType: 'codex',
        prompt: start.updateLead ? '' : (context?.payload.prompt ?? ''),
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
    event.providerSession?.id !== context?.providerSession?.id
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
      replacement ? undefined : context?.payload,
      remoteRosterAuthority
    )
  }
}
