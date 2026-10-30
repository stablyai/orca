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

  const toolName = readAntigravityToolCall(hookPayload).toolName
  if (
    conversationId &&
    (eventName === 'PreToolUse' || eventName === 'PostToolUse') &&
    isAntigravitySubagentTool(toolName)
  ) {
    state.antigravitySubagentParentByPaneKey.set(paneKey, conversationId)
  }

  const stopStillBusy = eventName === 'Stop' && isAntigravityStopStillBusy(hookPayload)
  // agy ends the parent's turn with fullyIdle=false while its helpers run; they hold the pane open.
  const heldOpenByHelpers = stopStillBusy && state.antigravitySubagentParentByPaneKey.has(paneKey)
  const stateName =
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

  if (!stateName) {
    return null
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
    mainAgent: heldOpenByHelpers ? { state: 'done', stateStartedAt: Date.now() } : undefined
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
