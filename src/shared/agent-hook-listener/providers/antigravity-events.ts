import { continueMainAgentStatus, foldAgentLeadStatus } from '../../agent-lead-status-fold'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
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
      return null
    }
    state.antigravitySubagentParentByPaneKey.delete(paneKey)
  }
  const toolName = readAntigravityToolCall(hookPayload).toolName
  if (
    conversationId &&
    (eventName === 'PreToolUse' || eventName === 'PostToolUse') &&
    isAntigravitySubagentTool(toolName)
  ) {
    state.antigravitySubagentParentByPaneKey.set(paneKey, conversationId)
  }
  const stopStillBusy = eventName === 'Stop' && isAntigravityStopStillBusy(hookPayload)
  if (eventName === 'PreInvocation') {
    state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  } else if (
    transcriptPath &&
    state.antigravityCompletedTranscriptByPaneKey.get(paneKey) === transcriptPath &&
    (eventName !== 'Stop' || stopStillBusy)
  ) {
    // Completed turns admit idle Stop text enrichment but cannot reopen from delayed hooks.
    return null
  }

  const leadState =
    eventName === 'PreToolUse' && isAntigravityFeedbackTool(toolName)
      ? 'waiting'
      : eventName === 'Stop'
        ? 'done'
        : eventName === 'PreInvocation' ||
            eventName === 'PostInvocation' ||
            eventName === 'PreToolUse' ||
            eventName === 'PostToolUse'
          ? 'working'
          : null

  if (!leadState) {
    return null
  }
  // fullyIdle=false is agy's own word that background work, such as its subagents, outlives the lead's turn.
  const { stateName } = foldAgentLeadStatus({
    leadState,
    childWorkLiveness: stopStillBusy ? 'working' : null
  })
  const mainAgent = continueMainAgentStatus(
    state.antigravityMainAgentStatusByPaneKey.get(paneKey),
    { state: leadState },
    Date.now()
  )
  state.antigravityMainAgentStatusByPaneKey.set(paneKey, mainAgent)

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

  const payload = normalizeAgentStatusPayload({
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
    mainAgent
  })
  // Stop between tools can report fullyIdle=false; only an idle Stop is terminal.
  if (eventName === 'Stop' && !stopStillBusy) {
    state.antigravitySubagentParentByPaneKey.delete(paneKey)
    if (transcriptPath) {
      state.antigravityCompletedTranscriptByPaneKey.set(paneKey, transcriptPath)
    }
  }
  return payload
}
