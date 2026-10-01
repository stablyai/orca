import {
  AGENT_MODEL_MAX_LENGTH,
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { normalizeOptionalField } from '../../agent-status-field-normalization'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  mainAgentTurnInterrupted,
  type AgentLeadStatusResolution
} from '../../agent-lead-status-fold'
import {
  codexRosterToSnapshots,
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
import {
  codexMainAgentStatusForPayload,
  codexOutcomeRestatedByStop,
  getOrCreateCodexSubagentRoster,
  getOrCreateCodexSubagentTranscriptState,
  hasCodexTranscriptSubagents,
  resolveCodexPaneStatus,
  setCodexMainAgentTurnState
} from './codex-state'

export function buildCodexStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  options: AgentLeadStatusResolution & { updateLead: boolean }
): ParsedAgentStatusPayload | null {
  const snapshot = options.updateLead
    ? resolveToolState(state, paneKey, extractToolFields('codex', eventName, hookPayload), {
        resetOnNewTurn: isNewTurnEvent('codex', eventName)
      })
    : (state.lastToolByPaneKey.get(paneKey) ?? {})
  const lead = state.codexLeadStateByPaneKey.get(paneKey)

  return normalizeAgentStatusPayload({
    state: options.stateName,
    workingMode: options.workingMode,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: options.updateLead && isNewTurnEvent('codex', eventName)
    }),
    agentType: 'codex',
    model: lead?.model,
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
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

/** Settles the open root turn once its rollout records the end; a child hook can be the pane's
 *  last event when the root turn fails, and Codex runs no root hook for that failure. */
function settleCodexRootTurnFromTranscript(state: HookListenerState, paneKey: string): void {
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  const transcriptState = state.codexSubagentTranscriptByPaneKey.get(paneKey)
  const parentPath = transcriptState?.parent.filePath
  if (!lead?.turnId || lead.state === 'done' || !transcriptState || !parentPath) {
    return
  }
  reconcileCodexSubagentTranscript(
    transcriptState,
    getOrCreateCodexSubagentRoster(state, paneKey),
    parentPath
  )
  const turnEnd = codexTranscriptTurnEnd(transcriptState, lead.turnId)
  if (turnEnd) {
    setCodexMainAgentTurnState(state, paneKey, {
      state: 'done',
      ...(turnEnd === 'failed' ? { outcome: 'failure' as const } : {}),
      model: lead.model,
      turnId: lead.turnId
    })
  }
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
  } else {
    finishCodexSubagent(roster, agentId)
  }
  settleCodexRootTurnFromTranscript(state, paneKey)
  return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload)
}

/**
 * Drops a `PermissionRequest` wait that Codex's own review agent owns.
 *
 * Codex runs this hook as decider #1, ahead of both its review agent and the user, so the event
 * alone is "a decision is being made", not "a human is blocked". Under `approvals_reviewer =
 * auto_review` ("Approve for me") the review agent resolves it seconds later and the pane flapped
 * between Needs You and Working for every gated tool call (STA-7698).
 *
 * `request_user_input` is untouched: it arrives as `PreToolUse`, and no reviewer can answer a
 * question addressed to the user (#9861).
 */
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
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
    return normalizeCodexSubagentLifecycleEvent(state, eventName, paneKey, hookPayload)
  }

  // Why: Codex's request_user_input (0.145+) is auto-allowed, so it fires PreToolUse while blocked on a human answer; map to waiting like grok's ask_user_question.
  const isUserInputPreTool =
    eventName === 'PreToolUse' &&
    isAskUserQuestionTool(readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name'))
  const stateName =
    eventName === 'SessionStart' ||
    eventName === 'UserPromptSubmit' ||
    (eventName === 'PreToolUse' && !isUserInputPreTool) ||
    eventName === 'PostToolUse'
      ? 'working'
      : eventName === 'PermissionRequest' || isUserInputPreTool
        ? 'waiting'
        : eventName === 'Stop'
          ? 'done'
          : null
  if (!stateName) {
    return null
  }

  const agentId = readString(hookPayload, 'agent_id')
  if (eventName === 'SessionStart' && hookPayload['source'] === 'compact') {
    // Why: Codex fires it mid-turn after compacting, with no `turn_id` and no new process, so the
    // turn's last real hook must stay the one the rollout poll re-reads.
    return null
  }
  const transcriptPath = readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
  if (eventName === 'SessionStart' && !agentId) {
    // Why: a pane can host a new Codex process after the old one exited without child Stop hooks.
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
    settleCodexRootTurnFromTranscript(state, paneKey)
    return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload)
  }

  const turnId = readString(hookPayload, 'turn_id')
  // Why: Codex runs no hook when a turn fails, so its rollout's record of this turn's end stands in for Stop.
  const transcriptTurnEnd =
    stateName !== 'done' && turnId
      ? codexTranscriptTurnEnd(state.codexSubagentTranscriptByPaneKey.get(paneKey), turnId)
      : undefined
  const leadEventName = transcriptTurnEnd ? 'Stop' : eventName
  if (leadEventName === 'Stop' && !hasCodexTranscriptSubagents(state, paneKey)) {
    // Why: Codex CLI 0.144 can omit child Stop hooks; later child activity safely recreates any agent still running.
    state.codexSubagentRosterByPaneKey.delete(paneKey)
  }
  // Why: resolved after the transcript reconcile above, so this turn's reviewer is read from the
  // rollout during the very PermissionRequest being classified, not from a prior event.
  const ownedState = transcriptTurnEnd
    ? 'done'
    : resolveCodexApprovalOwnedState(state, eventName, paneKey, transcriptPath, stateName)
  const previousLead = state.codexLeadStateByPaneKey.get(paneKey)
  const record = setCodexMainAgentTurnState(state, paneKey, {
    state: ownedState,
    ...(transcriptTurnEnd === 'failed'
      ? { outcome: 'failure' as const }
      : codexOutcomeRestatedByStop(previousLead, ownedState)),
    model:
      normalizeOptionalField(hookPayload['model'], AGENT_MODEL_MAX_LENGTH) ??
      (eventName === 'SessionStart' ? undefined : previousLead?.model),
    turnId
  })
  return buildCodexStatusPayload(state, leadEventName, promptText, paneKey, hookPayload, {
    ...resolveCodexPaneStatus(state, paneKey, record),
    updateLead: true
  })
}
