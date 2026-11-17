import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../../agent-status/contracts/agent-status-types'
import type { AgentSubagentSnapshot } from '../../../agent-status/contracts/agent-status-subagent-snapshot'
import type { AgentChildWorkLiveness } from '../../../agent-status/child-work/agent-status-child-work-liveness'
import {
  continueMainAgentStatus,
  foldAgentLeadStatus
} from '../../../agent-status/lifecycle/agent-lead-status-fold'
import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import { readFirstString } from '../../interactive-tool'
import type { HookListenerState } from '../../listener-state'
import { resolvePrompt, resolveToolState } from '../../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../../provider-event-routing'
import { readLastUserPromptFromTranscript } from '../../transcript-lines'
import {
  isAntigravityFeedbackTool,
  isAntigravityStopStillBusy,
  isAntigravitySubagentTool,
  isRecognizedAntigravityEvent,
  resolveSimpleAntigravityEventState
} from './antigravity-event-rules'
import {
  classifyAntigravityTranscriptOrigin,
  normalizeAntigravityModel,
  readAntigravityTranscriptModel,
  resolveAntigravityBrainDirectory
} from './antigravity-brain-metadata'
import {
  getOrCreateAntigravityPaneState,
  reconcileAntigravityActiveSubagents,
  recordAntigravityChildHook,
  type AntigravityPaneChildState
} from './antigravity-subagent-roster'
import { readAntigravityToolCall } from './antigravity-tool-fields'

export { isAntigravityFeedbackTool }

/** agy sends a backgrounded run_command's PostToolUse only when the command ends; daemons are never expected to. */
function trackAntigravityBackgroundCommand(
  paneState: AntigravityPaneChildState,
  eventName: unknown,
  conversationId: string | undefined,
  hookPayload: Record<string, unknown>
): void {
  const { toolName, toolInputSource } = readAntigravityToolCall(hookPayload)
  const stepIdx = hookPayload.stepIdx
  if (
    toolName !== 'run_command' ||
    !conversationId ||
    typeof stepIdx !== 'number' ||
    (eventName !== 'PreToolUse' && eventName !== 'PostToolUse')
  ) {
    return
  }
  const key = `${conversationId}:${stepIdx}`
  if (eventName === 'PostToolUse') {
    paneState.commands?.delete(key)
    return
  }
  if (isRecord(toolInputSource) && toolInputSource.IsDaemon === true) {
    return
  }
  paneState.commands = (paneState.commands ?? new Set()).add(key)
}

export function isAntigravityInSessionChildHook(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): boolean {
  const rootConversationId = state.antigravityChildWorkByPaneKey.get(paneKey)?.rootConversationId
  const conversationId = readFirstString(hookPayload, ['conversationId', 'conversation_id'])
  if (!rootConversationId || !conversationId || conversationId === rootConversationId) {
    return false
  }
  const transcriptPath = readFirstString(hookPayload, ['transcriptPath', 'transcript_path'])
  return classifyAntigravityTranscriptOrigin(transcriptPath) !== 'root'
}

export function buildAntigravityFoldedStatusPayload(
  state: HookListenerState,
  paneKey: string,
  paneState: AntigravityPaneChildState,
  now: number,
  options?: { subagents?: AgentSubagentSnapshot[] }
): ParsedAgentStatusPayload | null {
  const subagents = options?.subagents ?? reconcileAntigravityActiveSubagents(paneState, now)
  const leadState = paneState.leadState ?? 'working'
  const leadStateStartedAt = paneState.leadStateStartedAt ?? now
  const hasWaitingSubagent = subagents.some((subagent) => subagent.state === 'waiting')
  const hasCommands = (paneState.commands?.size ?? 0) > 0
  const liveness: AgentChildWorkLiveness = hasWaitingSubagent
    ? 'waiting'
    : subagents.length > 0 ||
        (leadState === 'done' &&
          paneState.hasSpawnedHelper === true &&
          paneState.children.size === 0)
      ? 'working'
      : hasCommands
        ? 'monitoring'
        : null
  const folded = foldAgentLeadStatus({ leadState, childWorkLiveness: liveness })
  const snapshot = state.lastToolByPaneKey.get(paneKey)
  const prompt = state.lastPromptByPaneKey.get(paneKey) ?? ''

  return normalizeAgentStatusPayload({
    state: folded.stateName,
    ...(folded.workingMode ? { workingMode: folded.workingMode } : {}),
    prompt,
    agentType: 'antigravity',
    model: paneState.leadModel,
    toolName: snapshot?.toolName,
    toolInput: snapshot?.toolInput,
    interactivePrompt: snapshot?.interactivePrompt,
    lastAssistantMessage: snapshot?.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot?.lastAssistantMessageIsToolOutput,
    subagents: subagents.length > 0 ? subagents : undefined,
    mainAgent: { state: leadState, stateStartedAt: leadStateStartedAt }
  })
}

function normalizeColdChildAntigravityEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  transcriptPath: string | undefined
): ParsedAgentStatusPayload | null {
  const toolName = readAntigravityToolCall(hookPayload).toolName
  const stopStillBusy = eventName === 'Stop' && isAntigravityStopStillBusy(hookPayload)
  const stateName = resolveSimpleAntigravityEventState(eventName, toolName, stopStillBusy)
  if (!stateName) {
    return null
  }
  const resetsTurn = isNewTurnEvent('antigravity', eventName)
  const cachedPrompt = resetsTurn ? undefined : state.lastPromptByPaneKey.get(paneKey)
  const effectivePrompt =
    promptText || cachedPrompt || readLastUserPromptFromTranscript(transcriptPath) || ''
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('antigravity', eventName, hookPayload),
    { resetOnNewTurn: resetsTurn }
  )
  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, effectivePrompt, { resetOnNewTurn: resetsTurn }),
    agentType: 'antigravity',
    model: normalizeAntigravityModel(readFirstString(hookPayload, ['modelName', 'model'])),
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput
  })
}

export function normalizeAntigravityEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (!isRecognizedAntigravityEvent(eventName)) {
    return null
  }
  const now = Date.now()
  const transcriptPath = readFirstString(hookPayload, ['transcriptPath', 'transcript_path'])
  const conversationId = readFirstString(hookPayload, ['conversationId', 'conversation_id'])
  const origin = classifyAntigravityTranscriptOrigin(transcriptPath)
  const existingPaneState = state.antigravityChildWorkByPaneKey.get(paneKey)

  // Cold child hooks after a restart must carry no root resume/child ownership.
  if (!existingPaneState?.rootConversationId && origin === 'child') {
    return normalizeColdChildAntigravityEvent(
      state,
      eventName,
      promptText,
      paneKey,
      hookPayload,
      transcriptPath
    )
  }

  if (
    existingPaneState?.rootConversationId &&
    conversationId &&
    conversationId !== existingPaneState.rootConversationId &&
    origin !== 'root'
  ) {
    trackAntigravityBackgroundCommand(existingPaneState, eventName, conversationId, hookPayload)
    recordAntigravityChildHook(
      existingPaneState,
      conversationId,
      eventName,
      hookPayload,
      transcriptPath,
      now
    )
    return buildAntigravityFoldedStatusPayload(state, paneKey, existingPaneState, now)
  }

  if (
    conversationId &&
    existingPaneState?.rootConversationId &&
    existingPaneState.rootConversationId !== conversationId &&
    origin === 'root'
  ) {
    state.antigravityChildWorkByPaneKey.delete(paneKey)
    state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  }

  if (eventName === 'PreInvocation') {
    state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  } else if (
    transcriptPath &&
    eventName !== 'Stop' &&
    state.antigravityCompletedTranscriptByPaneKey.get(paneKey) === transcriptPath
  ) {
    const active = existingPaneState
      ? reconcileAntigravityActiveSubagents(existingPaneState, now)
      : []
    if (active.length === 0) {
      // Ignore bookkeeping PostToolUse after Stop so finished rows do not resurrect.
      return null
    }
  }

  const paneState = getOrCreateAntigravityPaneState(state, paneKey)
  const toolName = readAntigravityToolCall(hookPayload).toolName
  const brainDir = resolveAntigravityBrainDirectory(hookPayload, transcriptPath)
  if (
    conversationId &&
    !paneState.rootConversationId &&
    (origin === 'root' ||
      (!transcriptPath &&
        (Boolean(promptText || readFirstString(hookPayload, ['lastUserInput'])) ||
          isAntigravitySubagentTool(toolName))))
  ) {
    paneState.rootConversationId = conversationId
  }
  if (brainDir && (!conversationId || paneState.rootConversationId === conversationId)) {
    paneState.rootBrainDir = brainDir
  }

  if (
    (eventName === 'PreToolUse' || eventName === 'PostToolUse') &&
    isAntigravitySubagentTool(toolName)
  ) {
    paneState.hasSpawnedHelper = true
  }
  trackAntigravityBackgroundCommand(paneState, eventName, conversationId, hookPayload)

  const hookModel = normalizeAntigravityModel(readFirstString(hookPayload, ['modelName', 'model']))
  paneState.leadModel =
    hookModel ?? paneState.leadModel ?? readAntigravityTranscriptModel(transcriptPath)

  const resetsTurn = isNewTurnEvent('antigravity', eventName)
  if (resetsTurn) {
    paneState.hasSpawnedHelper = false
  }
  const stopStillBusy = eventName === 'Stop' && isAntigravityStopStillBusy(hookPayload)
  if (eventName === 'Stop' && !stopStillBusy) {
    paneState.hasSpawnedHelper = false
  }
  const subagents = reconcileAntigravityActiveSubagents(paneState, now)
  const hasBackgroundHold =
    subagents.length > 0 ||
    (paneState.hasSpawnedHelper === true && paneState.children.size === 0) ||
    (paneState.commands?.size ?? 0) > 0
  // Stop between tools reports fullyIdle=false without background work; stay working until truly idle or held.
  const leadState =
    eventName === 'PreToolUse' && isAntigravityFeedbackTool(toolName)
      ? 'waiting'
      : eventName === 'Stop'
        ? stopStillBusy && !hasBackgroundHold
          ? 'working'
          : 'done'
        : 'working'

  const previousLead =
    paneState.leadState && paneState.leadStateStartedAt !== undefined
      ? { state: paneState.leadState, stateStartedAt: paneState.leadStateStartedAt }
      : undefined
  const nextLead = continueMainAgentStatus(previousLead, { state: leadState }, now)
  paneState.leadState = nextLead.state
  paneState.leadStateStartedAt = nextLead.stateStartedAt

  const cachedPrompt = resetsTurn ? undefined : state.lastPromptByPaneKey.get(paneKey)
  const effectivePrompt =
    promptText || cachedPrompt || readLastUserPromptFromTranscript(transcriptPath) || ''
  resolvePrompt(state, paneKey, effectivePrompt, { resetOnNewTurn: resetsTurn })
  resolveToolState(state, paneKey, extractToolFields('antigravity', eventName, hookPayload), {
    resetOnNewTurn: resetsTurn
  })

  const payload = buildAntigravityFoldedStatusPayload(state, paneKey, paneState, now, {
    subagents
  })
  if (eventName === 'Stop' && !stopStillBusy && subagents.length === 0) {
    state.antigravityChildWorkByPaneKey.delete(paneKey)
    if (transcriptPath) {
      state.antigravityCompletedTranscriptByPaneKey.set(paneKey, transcriptPath)
    }
  }
  return payload
}
