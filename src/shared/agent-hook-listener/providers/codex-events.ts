import {
  AGENT_MODEL_MAX_LENGTH,
  normalizeOptionalField
} from '../../agent-status/contracts/agent-status-field-normalization'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status/contracts/agent-status-types'

import {
  mainAgentTurnInterrupted,
  type AgentLeadStatusResolution
} from '../../agent-status/lifecycle/agent-lead-status-fold'
import {
  codexRosterToSnapshots,
  enrichCodexSubagentIdentity,
  finishCodexSubagent,
  upsertCodexSubagent
} from '../../codex-subagent-roster'
import {
  codexTranscriptTurnEnd,
  reconcileCodexSubagentTranscript
} from '../../codex-subagent-transcript'
import {
  codexTurnApprovalsAreAutoReviewed,
  reconcileCodexSubagentReviewer
} from '../../codex-subagent-reviewer'
import { readFirstString } from '../interactive-tool'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import { applyCodexSessionStart } from './codex-session-start'
import {
  codexHookEventState,
  codexMainAgentStatusForPayload,
  codexLeadOutcomeForEvent,
  getOrCreateCodexSubagentRoster,
  getOrCreateCodexSubagentTranscriptState,
  hasCodexTranscriptSubagents,
  resolveCodexPaneStatus,
  setCodexMainAgentTurnState
} from './codex-state'
import { pendingCodexAsyncQuestion, trackCodexAsyncQuestions } from './codex-async-questions'

export function buildCodexStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  options: AgentLeadStatusResolution & { updateLead: boolean; sessionBoundary?: true }
): ParsedAgentStatusPayload | null {
  const snapshot = options.updateLead
    ? resolveToolState(state, paneKey, extractToolFields('codex', eventName, hookPayload), {
        resetOnNewTurn: isNewTurnEvent('codex', eventName)
      })
    : (state.lastToolByPaneKey.get(paneKey) ?? {})
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  // An approval or blocking question on screen wins; otherwise a waiting row shows the open async question.
  const asyncQuestion =
    options.stateName === 'waiting' && !snapshot.interactivePrompt
      ? pendingCodexAsyncQuestion(state, paneKey)
      : undefined

  return normalizeAgentStatusPayload({
    state: options.stateName,
    workingMode: options.workingMode,
    sessionBoundary: options.sessionBoundary,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: options.updateLead && isNewTurnEvent('codex', eventName)
    }),
    agentType: 'codex',
    model: lead?.model,
    toolName: asyncQuestion?.toolName ?? snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: asyncQuestion?.prompt ?? snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    interrupted: mainAgentTurnInterrupted(lead),
    subagents: codexRosterToSnapshots(state.codexSubagentRosterByPaneKey.get(paneKey)),
    mainAgent: codexMainAgentStatusForPayload(lead)
  })
}

export function buildCodexChildDrivenStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  // Why: a child event before any root event means the root is mid-turn; nothing else spawns.
  const lead = state.codexLeadStateByPaneKey.get(paneKey) ?? { state: 'working' as const }
  return buildCodexStatusPayload(state, eventName, '', paneKey, hookPayload, {
    ...resolveCodexPaneStatus(state, paneKey, lead),
    updateLead: false
  })
}

export function normalizeCodexSubagentLifecycleEvent(
  state: HookListenerState,
  eventName: 'SubagentStart' | 'SubagentStop',
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const agentId = readString(hookPayload, 'agent_id')
  if (!agentId) {
    return null
  }
  const roster = getOrCreateCodexSubagentRoster(state, paneKey)
  if (eventName === 'SubagentStart') {
    upsertCodexSubagent(
      roster,
      agentId,
      {
        agentType: readString(hookPayload, 'agent_type'),
        model: readString(hookPayload, 'model'),
        state: 'working'
      },
      Date.now()
    )
    enrichCodexSubagentIdentity(
      roster,
      agentId,
      readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
    )
    const parentPath =
      state.codexSubagentTranscriptByPaneKey.get(paneKey)?.parent.filePath ??
      state.lastStatusByPaneKey.get(paneKey)?.providerSession?.transcriptPath
    if (parentPath) {
      reconcileCodexSubagentTranscript(
        getOrCreateCodexSubagentTranscriptState(state, paneKey),
        roster,
        parentPath
      )
    }
  } else {
    finishCodexSubagent(roster, agentId)
    state.codexSubagentTranscriptByPaneKey.get(paneKey)?.subagents.delete(agentId)
  }
  return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload)
}

/** Codex PermissionRequest precedes reviewer/user decisions; suppress reviewer-owned waiting (STA-7698). request_user_input still blocks a human on PreToolUse (#9861). */
function resolveCodexApprovalOwnedState(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  transcriptPath: string | undefined,
  stateName: 'working' | 'waiting' | 'done'
): 'working' | 'waiting' | 'done' {
  if (stateName !== 'waiting' || eventName !== 'PermissionRequest') {
    return stateName
  }
  return codexTurnApprovalsAreAutoReviewed(
    state.codexSubagentTranscriptByPaneKey.get(paneKey),
    transcriptPath
  )
    ? 'working'
    : stateName
}

export function normalizeCodexEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  originalEventName: unknown = eventName
): ParsedAgentStatusPayload | null {
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
    return normalizeCodexSubagentLifecycleEvent(state, eventName, paneKey, hookPayload)
  }

  if (eventName === 'SessionStart' && originalEventName !== 'UserPromptSubmit') {
    const start = applyCodexSessionStart(state, paneKey, {
      sessionId: readString(hookPayload, 'session_id'),
      source: readString(hookPayload, 'source'),
      agentId: readString(hookPayload, 'agent_id'),
      model: normalizeOptionalField(hookPayload.model, AGENT_MODEL_MAX_LENGTH)
    })
    return start && buildCodexStatusPayload(state, eventName, '', paneKey, hookPayload, start)
  }

  const activityEventName =
    eventName === 'SessionStart' && originalEventName === 'UserPromptSubmit'
      ? originalEventName
      : eventName
  const stateName = codexHookEventState(
    activityEventName,
    readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
  )
  if (!stateName) {
    return null
  }

  const agentId = readString(hookPayload, 'agent_id')
  const transcriptPath = readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
  if (eventName === 'SessionStart' && !agentId) {
    // New processes must not retain children whose Stop hooks were lost.
    state.codexSubagentRosterByPaneKey.delete(paneKey)
    state.codexSubagentTranscriptByPaneKey.delete(paneKey)
  }
  if (agentId && transcriptPath && eventName === 'PermissionRequest') {
    const transcriptState = getOrCreateCodexSubagentTranscriptState(state, paneKey)
    if (transcriptState.parent.filePath === transcriptPath) {
      reconcileCodexSubagentTranscript(
        transcriptState,
        getOrCreateCodexSubagentRoster(state, paneKey),
        transcriptPath
      )
    } else {
      reconcileCodexSubagentReviewer(transcriptState, transcriptPath)
    }
  }
  if (transcriptPath && !agentId) {
    reconcileCodexSubagentTranscript(
      getOrCreateCodexSubagentTranscriptState(state, paneKey),
      getOrCreateCodexSubagentRoster(state, paneKey),
      transcriptPath
    )
  }
  if (!agentId && (eventName === 'UserPromptSubmit' || eventName === 'SessionStart')) {
    const transcript = state.codexSubagentTranscriptByPaneKey.get(paneKey)
    if (transcript) {
      transcript.rootTurn.interrupted = false
    }
  }
  if (agentId) {
    // Why: reconcile the child rollout reviewer before classifying its approval, including after relay restart.
    const childState = resolveCodexApprovalOwnedState(
      state,
      eventName,
      paneKey,
      transcriptPath,
      stateName
    )
    upsertCodexSubagent(
      getOrCreateCodexSubagentRoster(state, paneKey),
      agentId,
      {
        agentType: readString(hookPayload, 'agent_type'),
        model: readString(hookPayload, 'model'),
        state: childState === 'waiting' ? 'waiting' : 'working'
      },
      Date.now()
    )
    enrichCodexSubagentIdentity(
      getOrCreateCodexSubagentRoster(state, paneKey),
      agentId,
      transcriptPath
    )
    return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload)
  }

  if (eventName === 'Stop' && !hasCodexTranscriptSubagents(state, paneKey)) {
    // Clear the existing roster so missing child Stops cannot reseed stale children from the previous row (CLI0.144).
    getOrCreateCodexSubagentRoster(state, paneKey).clear()
  }
  // Classify with reviewer evidence just read from this turn's rollout, never a prior event.
  const ownedState = resolveCodexApprovalOwnedState(
    state,
    eventName,
    paneKey,
    transcriptPath,
    stateName
  )
  // An open async question needs the user even while Codex keeps working.
  const leadState =
    trackCodexAsyncQuestions(state, paneKey, eventName, hookPayload) && ownedState === 'working'
      ? 'waiting'
      : ownedState
  const previousLead = state.codexLeadStateByPaneKey.get(paneKey)
  const transcript = state.codexSubagentTranscriptByPaneKey.get(paneKey)
  const turnId = readString(hookPayload, 'turn_id')
  const sessionId = readString(hookPayload, 'session_id')
  // Why: Codex fires no Stop for a failed turn, so a Stop for one is the rollout's end replayed.
  const failedTurn =
    eventName === 'Stop' &&
    previousLead?.state !== 'done' &&
    turnId !== undefined &&
    codexTranscriptTurnEnd(transcript, turnId) === 'failed'
  const startsTurn = activityEventName === 'UserPromptSubmit'
  const record = setCodexMainAgentTurnState(state, paneKey, {
    state: leadState,
    ...(startsTurn &&
    ((turnId && turnId !== previousLead?.turnId) ||
      (sessionId && sessionId !== previousLead?.sessionId))
      ? { stateStartedAt: Date.now() }
      : {}),
    ...(failedTurn
      ? { outcome: 'failure' as const }
      : codexLeadOutcomeForEvent(eventName, previousLead, leadState)),
    model:
      normalizeOptionalField(hookPayload['model'], AGENT_MODEL_MAX_LENGTH) ??
      (eventName === 'SessionStart' ? undefined : previousLead?.model),
    sessionId,
    turnId: turnId ?? (startsTurn ? null : undefined)
  })
  return buildCodexStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
    ...resolveCodexPaneStatus(state, paneKey, record),
    updateLead: true
  })
}

export { codexHookEventForEndedTurn } from './codex-ended-turn-event'
