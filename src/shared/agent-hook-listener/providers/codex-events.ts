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
  codexTurnApprovalsAreAutoReviewed,
  reconcileCodexSubagentReviewer
} from '../../codex-subagent-reviewer'
import { readFirstString } from '../interactive-tool'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import { recordCodexChildRollout } from '../../codex-subagent-transcript'
import { catchUpOnCodexParentRollout } from './codex-rollout-reader'
import {
  codexMainAgentStatusForPayload,
  codexRolloutOpenTurnId,
  codexRolloutTurnEnd,
  getOrCreateCodexSubagentRoster,
  getOrCreateCodexSubagentTranscriptState,
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
  // Why: with no record of the main agent (its records were cleared, or it predates this host),
  // the children alone drive the row; nothing would end an assumed-working main agent.
  const lead = state.codexLeadStateByPaneKey.get(paneKey) ?? { state: 'done' as const }
  return buildCodexStatusPayload(state, eventName, '', paneKey, hookPayload, {
    ...resolveCodexPaneStatus(state, paneKey, lead),
    updateLead: false
  })
}

/** A child's own hooks name its rollout (`transcript_path`), which the parent's reads then use. */
function recordChildRolloutFromHook(
  state: HookListenerState,
  paneKey: string,
  agentId: string,
  transcriptPath: string | undefined
): void {
  const transcriptState = state.codexSubagentTranscriptByPaneKey.get(paneKey)
  const child = state.codexSubagentRosterByPaneKey.get(paneKey)?.get(agentId)
  if (transcriptState && child) {
    recordCodexChildRollout(transcriptState, agentId, transcriptPath, child.startedAt)
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
    recordChildRolloutFromHook(
      state,
      paneKey,
      agentId,
      readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
    )
  } else {
    finishCodexSubagent(roster, agentId)
  }
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
    catchUpOnCodexParentRollout(state, paneKey, undefined)
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
        : eventName === 'Stop' || eventName === 'Interrupt'
          ? 'done'
          : null
  if (!stateName) {
    return null
  }

  const agentId = readString(hookPayload, 'agent_id')
  const transcriptPath = readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
  // Why: compaction fires SessionStart mid-turn in the same session and rollout; only a real
  // session start (startup, resume, clear, fork) may drop what the pane's rollout established.
  const compaction = eventName === 'SessionStart' && readString(hookPayload, 'source') === 'compact'
  if (eventName === 'SessionStart' && !agentId && !compaction) {
    // Why: a pane can host a new Codex process after the old one exited without child Stop hooks.
    state.codexSubagentRosterByPaneKey.delete(paneKey)
    state.codexSubagentTranscriptByPaneKey.delete(paneKey)
  }
  catchUpOnCodexParentRollout(state, paneKey, agentId ? undefined : transcriptPath)
  if (agentId && transcriptPath && eventName === 'PermissionRequest') {
    const transcriptState = getOrCreateCodexSubagentTranscriptState(state, paneKey)
    if (transcriptState.parent.filePath !== transcriptPath) {
      reconcileCodexSubagentReviewer(transcriptState, transcriptPath)
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
    recordChildRolloutFromHook(state, paneKey, agentId, transcriptPath)
    return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload)
  }

  // Why: resolved after the transcript reconcile above, so this turn's reviewer is read from the
  // rollout during the very PermissionRequest being classified, not from a prior event.
  const ownedState = resolveCodexApprovalOwnedState(
    state,
    eventName,
    paneKey,
    transcriptPath,
    stateName
  )
  const previousLead = state.codexLeadStateByPaneKey.get(paneKey)
  const previousTurnId = previousLead?.turnId
  // Why: SessionStart carries no turn_id. It belongs to the turn Codex has open, and a compaction
  // continues the root's own turn while Codex has not ended it.
  const turnId =
    readString(hookPayload, 'turn_id') ??
    codexRolloutOpenTurnId(state, paneKey) ??
    (compaction && previousTurnId && !codexRolloutTurnEnd(state, paneKey, previousTurnId)
      ? previousTurnId
      : undefined)
  const record = setCodexMainAgentTurnState(state, paneKey, {
    state: ownedState,
    ...(eventName === 'Interrupt' ? { outcome: 'cancellation' as const } : {}),
    turnId,
    model:
      normalizeOptionalField(hookPayload['model'], AGENT_MODEL_MAX_LENGTH) ??
      (eventName === 'SessionStart' ? undefined : previousLead?.model)
  })
  return buildCodexStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
    ...resolveCodexPaneStatus(state, paneKey, record),
    updateLead: true
  })
}
