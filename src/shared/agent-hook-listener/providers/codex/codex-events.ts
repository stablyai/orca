import {
  AGENT_MODEL_MAX_LENGTH,
  normalizeOptionalField
} from '../../../agent-status/contracts/agent-status-field-normalization'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../../agent-status/contracts/agent-status-types'

import {
  mainAgentTurnInterrupted,
  type AgentLeadStatusResolution
} from '../../../agent-status/lifecycle/agent-lead-status-fold'
import {
  codexRosterToSnapshots,
  finishCodexSubagent,
  markCodexSubagentHookEvidence,
  queueCodexSubagentIdentity,
  retireUnobservedCodexSubagents,
  upsertCodexSubagent
} from './codex-subagent-roster'
import {
  codexTranscriptTurnEnd,
  codexApprovalToolKey,
  followCodexRootRollout,
  forgetCodexChildRollout,
  requestCodexRolloutReviewer
} from './codex-rollout-state'
import { normalizedTranscriptPath } from './codex-rollout-paths'
import { resolveCodexApprovalOwnedState } from './codex-approval-classification'
import { readFirstString } from '../../interactive-tool'
import type { HookListenerState } from '../../listener-state'
import { resolvePrompt, resolveToolState } from '../../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../../provider-event-routing'
import { readString } from '../../tool-input-preview'
import { applyCodexSessionStart } from './codex-session-start'
import {
  codexHookEventState,
  codexMainAgentStatusForPayload,
  codexLeadOutcomeForEvent,
  getOrCreateCodexRolloutState,
  getOrCreateCodexSubagentRoster,
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
    markCodexSubagentHookEvidence(roster, agentId, {
      now: Date.now(),
      rolloutPath: normalizedTranscriptPath(
        readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
      )
    })
    // Hooks only say `default`; the child's own rollout header holds its name, read once off-thread.
    queueCodexSubagentIdentity(
      roster,
      agentId,
      readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
    )
  } else {
    finishCodexSubagent(roster, agentId)
    const rollout = state.codexRolloutByPaneKey.get(paneKey)
    if (rollout) {
      forgetCodexChildRollout(rollout, agentId)
    }
  }
  return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload)
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
    state.codexRolloutByPaneKey.delete(paneKey)
  }
  if (!agentId) {
    const rollout = transcriptPath
      ? getOrCreateCodexRolloutState(state, paneKey)
      : state.codexRolloutByPaneKey.get(paneKey)
    if (rollout) {
      rollout.lastRootHookAt = Date.now()
      followCodexRootRollout(rollout, transcriptPath)
      if (eventName === 'UserPromptSubmit' || eventName === 'Stop' || eventName === 'Interrupt') {
        rollout.epoch += 1
      }
      if (eventName === 'UserPromptSubmit' || eventName === 'SessionStart') {
        rollout.rootTurn.interrupted = false
      }
      // Prefetch the turn's reviewer so a later approval rarely waits on a read.
      if (activityEventName === 'UserPromptSubmit' && rollout.root) {
        rollout.turnReviewerRequest = requestCodexRolloutReviewer(
          rollout,
          rollout.root.cursor.filePath
        )
      }
    }
  }
  if (agentId) {
    const roster = getOrCreateCodexSubagentRoster(state, paneKey)
    const child = resolveCodexApprovalOwnedState(
      state,
      eventName,
      paneKey,
      transcriptPath,
      stateName,
      hookPayload
    )
    upsertCodexSubagent(
      roster,
      agentId,
      {
        agentType: readString(hookPayload, 'agent_type'),
        model: readString(hookPayload, 'model'),
        state: child.state === 'waiting' ? 'waiting' : 'working'
      },
      Date.now()
    )
    markCodexSubagentHookEvidence(roster, agentId, {
      now: Date.now(),
      rolloutPath: normalizedTranscriptPath(transcriptPath),
      answeredToolKey: eventName === 'PostToolUse' ? codexApprovalToolKey(hookPayload) : undefined
    })
    const tracked = roster.get(agentId.trim())
    if (tracked && child.hold) {
      tracked.approvalHold = child.hold
    }
    queueCodexSubagentIdentity(roster, agentId, transcriptPath)
    return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload)
  }

  if (eventName === 'Stop') {
    // Hook-observed children end with their own SubagentStop (some outlive the root turn); only restored rows no hook confirmed go.
    retireUnobservedCodexSubagents(getOrCreateCodexSubagentRoster(state, paneKey))
  }
  const owned = resolveCodexApprovalOwnedState(
    state,
    eventName,
    paneKey,
    transcriptPath,
    stateName,
    hookPayload
  )
  // An open async question needs the user even while Codex keeps working.
  const leadState =
    trackCodexAsyncQuestions(state, paneKey, eventName, hookPayload) && owned.state === 'working'
      ? 'waiting'
      : owned.state
  const previousLead = state.codexLeadStateByPaneKey.get(paneKey)
  const rollout = state.codexRolloutByPaneKey.get(paneKey)
  const turnId = readString(hookPayload, 'turn_id')
  const sessionId = readString(hookPayload, 'session_id')
  // Why: Codex fires no Stop for a failed turn, so a Stop for one is the rollout's end replayed.
  const failedTurn =
    eventName === 'Stop' &&
    previousLead?.state !== 'done' &&
    turnId !== undefined &&
    codexTranscriptTurnEnd(rollout, turnId) === 'failed'
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
  if (rollout && owned.hold) {
    rollout.rootApprovalHold = { ...owned.hold, epoch: rollout.epoch, model: record.model }
  } else if (
    eventName === 'PostToolUse' &&
    rollout?.rootApprovalHold?.toolKey === codexApprovalToolKey(hookPayload)
  ) {
    // The approved tool ran, so its approval was answered.
    rollout.rootApprovalHold = undefined
  }
  return buildCodexStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
    ...resolveCodexPaneStatus(state, paneKey, record),
    updateLead: true
  })
}
