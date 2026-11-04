import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status/contracts/agent-status-types'
import {
  antigravityRosterToSnapshots,
  createAntigravitySubagentRoster,
  extractAntigravitySubagentSpawnIdentity,
  finishAntigravitySubagent,
  hasWaitingAntigravitySubagent,
  queueAntigravitySubagentSpawn,
  upsertAntigravitySubagent,
  type AntigravitySubagentRoster
} from '../../antigravity-subagent-roster'
import { readFirstString } from '../interactive-tool'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readLastUserPromptFromTranscript } from '../transcript-lines'
import { readAntigravityToolCall } from './antigravity-tool-fields'
import { isAntigravityStopStillBusy } from './antigravity-event-rules'

export function isAntigravityFeedbackTool(toolName: string | undefined): boolean {
  return toolName === 'ask_question' || toolName === 'ask_permission'
}

function isAntigravitySubagentTool(toolName: string | undefined): boolean {
  return toolName === 'invoke_subagent' || toolName === 'send_message'
}

function getOrCreateAntigravityRoster(
  state: HookListenerState,
  paneKey: string
): AntigravitySubagentRoster {
  let roster = state.antigravitySubagentRosterByPaneKey.get(paneKey)
  if (!roster) {
    roster = createAntigravitySubagentRoster()
    state.antigravitySubagentRosterByPaneKey.set(paneKey, roster)
  }
  return roster
}

function normalizeAntigravityChildEvent(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  conversationId: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const roster = getOrCreateAntigravityRoster(state, paneKey)
  const toolCall = readAntigravityToolCall(hookPayload)
  if (eventName === 'PreToolUse' && toolCall.toolName === 'invoke_subagent') {
    const identity = extractAntigravitySubagentSpawnIdentity(toolCall.toolInputSource)
    if (identity) {
      queueAntigravitySubagentSpawn(roster, identity)
    }
  }

  if (eventName === 'Stop') {
    if (isAntigravityStopStillBusy(hookPayload)) {
      upsertAntigravitySubagent(roster, conversationId, 'working', Date.now())
    } else {
      finishAntigravitySubagent(roster, conversationId)
    }
  } else if (eventName === 'PreToolUse' && isAntigravityFeedbackTool(toolCall.toolName)) {
    upsertAntigravitySubagent(roster, conversationId, 'waiting', Date.now())
  } else if (
    eventName === 'PreInvocation' ||
    eventName === 'PostInvocation' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    upsertAntigravitySubagent(roster, conversationId, 'working', Date.now())
  } else {
    return null
  }

  const lead = roster.lead
  if (lead?.state === 'done' && !lead.heldOpenByHelpers && roster.children.size === 0) {
    return null
  }

  const combinedState =
    lead?.state === 'waiting' || hasWaitingAntigravitySubagent(roster) ? 'waiting' : 'working'
  const snapshot = state.lastToolByPaneKey.get(paneKey) ?? {}
  return normalizeAgentStatusPayload({
    state: combinedState,
    prompt: state.lastPromptByPaneKey.get(paneKey) ?? '',
    agentType: 'antigravity',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    subagents: antigravityRosterToSnapshots(roster),
    mainAgent: lead?.heldOpenByHelpers
      ? { state: 'done', stateStartedAt: lead.stateStartedAt }
      : undefined
  })
}

export function normalizeAntigravityEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const transcriptPath = readFirstString(hookPayload, ['transcriptPath', 'transcript_path'])
  const conversationId = readFirstString(hookPayload, ['conversationId', 'conversation_id'])
  const subagentParent = state.antigravitySubagentParentByPaneKey.get(paneKey)
  if (subagentParent && conversationId && conversationId !== subagentParent) {
    // Subagents run inside the parent agy under their own conversationId and never carry user input.
    if (!readFirstString(hookPayload, ['lastUserInput'])) {
      return normalizeAntigravityChildEvent(state, eventName, paneKey, conversationId, hookPayload)
    }
    state.antigravitySubagentParentByPaneKey.delete(paneKey)
    state.antigravitySubagentRosterByPaneKey.delete(paneKey)
  }
  if (eventName === 'PreInvocation') {
    state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  } else if (
    transcriptPath &&
    eventName !== 'Stop' &&
    state.antigravityCompletedTranscriptByPaneKey.get(paneKey) === transcriptPath
  ) {
    // Ignore bookkeeping PostToolUse after Stop so finished rows do not resurrect.
    return null
  }

  const toolCall = readAntigravityToolCall(hookPayload)
  const toolName = toolCall.toolName
  if (
    conversationId &&
    (eventName === 'PreToolUse' || eventName === 'PostToolUse') &&
    isAntigravitySubagentTool(toolName)
  ) {
    state.antigravitySubagentParentByPaneKey.set(paneKey, conversationId)
    if (eventName === 'PreToolUse' && toolName === 'invoke_subagent') {
      const identity = extractAntigravitySubagentSpawnIdentity(toolCall.toolInputSource)
      if (identity) {
        queueAntigravitySubagentSpawn(getOrCreateAntigravityRoster(state, paneKey), identity)
      }
    }
  }

  const stopStillBusy = eventName === 'Stop' && isAntigravityStopStillBusy(hookPayload)
  // agy ends the parent's turn with fullyIdle=false while its helpers run; they hold the pane open.
  const heldOpenByHelpers = stopStillBusy && state.antigravitySubagentParentByPaneKey.has(paneKey)
  const leadState =
    eventName === 'PreToolUse' && isAntigravityFeedbackTool(toolName)
      ? 'waiting'
      : eventName === 'Stop'
        ? stopStillBusy
          ? 'working'
          : 'done'
        : eventName === 'PreInvocation' ||
            eventName === 'PostInvocation' ||
            eventName === 'PreToolUse' ||
            eventName === 'PostToolUse'
          ? 'working'
          : null

  if (!leadState) {
    return null
  }

  const roster = state.antigravitySubagentRosterByPaneKey.get(paneKey)
  if (roster || state.antigravitySubagentParentByPaneKey.has(paneKey)) {
    const activeRoster = getOrCreateAntigravityRoster(state, paneKey)
    const nextLeadState = heldOpenByHelpers ? 'done' : leadState
    const previousLead = activeRoster.lead
    const stateStartedAt =
      previousLead &&
      previousLead.state === nextLeadState &&
      previousLead.heldOpenByHelpers === heldOpenByHelpers
        ? previousLead.stateStartedAt
        : Date.now()
    activeRoster.lead = {
      state: nextLeadState,
      stateStartedAt,
      heldOpenByHelpers
    }
  }

  const resetsTurn = isNewTurnEvent('antigravity', eventName)
  // Cache prompts per turn instead of rescanning large transcripts per hook.
  const cachedPrompt = resetsTurn ? undefined : state.lastPromptByPaneKey.get(paneKey)
  const effectivePrompt =
    promptText || cachedPrompt || readLastUserPromptFromTranscript(transcriptPath) || ''
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('antigravity', eventName, hookPayload),
    { resetOnNewTurn: resetsTurn }
  )

  const stateName =
    leadState === 'working' && hasWaitingAntigravitySubagent(roster) ? 'waiting' : leadState

  // Stop between tools can report fullyIdle=false; only an idle Stop is terminal.
  if (eventName === 'Stop' && !stopStillBusy) {
    state.antigravitySubagentParentByPaneKey.delete(paneKey)
    state.antigravitySubagentRosterByPaneKey.delete(paneKey)
    if (transcriptPath) {
      state.antigravityCompletedTranscriptByPaneKey.set(paneKey, transcriptPath)
    }
  }

  const activeRoster = state.antigravitySubagentRosterByPaneKey.get(paneKey)
  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, effectivePrompt, {
      resetOnNewTurn: resetsTurn
    }),
    agentType: 'antigravity',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    subagents: antigravityRosterToSnapshots(activeRoster),
    mainAgent: heldOpenByHelpers
      ? { state: 'done', stateStartedAt: activeRoster?.lead?.stateStartedAt ?? Date.now() }
      : undefined
  })
}
