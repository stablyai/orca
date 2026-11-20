import {
  isAntigravityInSessionChildHook,
  type AntigravityTranscriptOrigin
} from './antigravity-hook-identity'
import { retireAntigravityChild, trackAntigravityBackgroundCommand } from './antigravity-pane-state'
import { buildAntigravityFoldedStatusPayload } from './antigravity-parent-status'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../../agent-status/contracts/agent-status-types'
import { continueMainAgentStatus } from '../../../agent-status/lifecycle/agent-lead-status-fold'
import { readFirstString } from '../../interactive-tool'
import type { HookListenerState } from '../../listener-state'
import { resolvePrompt, resolveToolState } from '../../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../../provider-event-routing'
import { readLastUserPromptFromTranscript } from '../../transcript-lines'
import {
  isAntigravityFeedbackTool,
  isAntigravityHelperSpawnTool,
  isAntigravityStopStillBusy,
  isAntigravitySubagentTool,
  isRecognizedAntigravityEvent,
  resolveSimpleAntigravityEventState
} from './antigravity-event-rules'
import {
  createAntigravityBrainCache,
  normalizeAntigravityModel,
  resolveAntigravityBrainDirectory
} from './antigravity-brain-metadata'
import {
  getOrCreateAntigravityPaneState,
  reconcileAntigravityActiveSubagents,
  recordAntigravityChildHook
} from './antigravity-subagent-roster'
import { readAntigravityToolCall } from './antigravity-tool-fields'

export { isAntigravityFeedbackTool }

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
  hookPayload: Record<string, unknown>,
  origin: AntigravityTranscriptOrigin
): ParsedAgentStatusPayload | null {
  if (!isRecognizedAntigravityEvent(eventName)) {
    return null
  }
  const now = Date.now()
  const transcriptPath = readFirstString(hookPayload, ['transcriptPath', 'transcript_path'])
  const conversationId = readFirstString(hookPayload, ['conversationId', 'conversation_id'])
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
    isAntigravityInSessionChildHook(state, paneKey, hookPayload, origin)
  ) {
    recordAntigravityChildHook(existingPaneState, conversationId, eventName, hookPayload, now)
    return null
  }

  if (
    conversationId &&
    existingPaneState?.rootConversationId &&
    existingPaneState.rootConversationId !== conversationId &&
    !isAntigravityInSessionChildHook(state, paneKey, hookPayload, origin)
  ) {
    state.antigravityChildWorkByPaneKey.delete(paneKey)
    state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  }

  const isCompletedBookkeeping = Boolean(
    transcriptPath &&
    eventName !== 'Stop' &&
    state.antigravityCompletedTranscriptByPaneKey.get(paneKey) === transcriptPath
  )
  if (eventName === 'PreInvocation') {
    state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  } else if (isCompletedBookkeeping) {
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
    paneState.rootTranscriptPath = transcriptPath
  }

  const resetsTurn = isNewTurnEvent('antigravity', eventName)
  if (!(eventName === 'Stop' && isAntigravityStopStillBusy(hookPayload))) {
    paneState.helpersIdleAt = undefined
  }
  const stopStillBusy = eventName === 'Stop' && isAntigravityStopStillBusy(hookPayload)
  if (resetsTurn || (eventName === 'Stop' && !stopStillBusy)) {
    paneState.awaitingInitialHelperDiscovery = undefined
  }
  if (
    (eventName === 'PreToolUse' || eventName === 'PostToolUse') &&
    isAntigravitySubagentTool(toolName)
  ) {
    paneState.discoversChildren = true
  }
  if (eventName === 'PreToolUse' && isAntigravityHelperSpawnTool(toolName)) {
    paneState.awaitingInitialHelperDiscovery = new Set(paneState.children.keys())
  }
  const finishedBackgroundCommand = trackAntigravityBackgroundCommand(
    paneState,
    eventName,
    conversationId,
    hookPayload
  )

  const rawModel = readFirstString(hookPayload, ['modelName', 'model'])
  if (rawModel) {
    paneState.leadModel = normalizeAntigravityModel(rawModel) ?? paneState.leadModel
  }

  if (eventName === 'Stop' && !stopStillBusy) {
    for (const id of paneState.children.keys()) {
      retireAntigravityChild(paneState, id)
    }
    paneState.children.clear()
    paneState.verifiedChildren.clear()
    paneState.brainCache = createAntigravityBrainCache()
    paneState.commands?.clear()
    paneState.discoversChildren = false
    paneState.dirty = false
    paneState.helpersIdleAt = undefined
  }
  const subagents = reconcileAntigravityActiveSubagents(paneState, now)
  const hasBackgroundHold =
    subagents.length > 0 ||
    paneState.awaitingInitialHelperDiscovery !== undefined ||
    (paneState.commands?.size ?? 0) > 0 ||
    paneState.helpersIdleAt !== undefined
  const preservesDoneLead =
    paneState.leadState === 'done' &&
    !resetsTurn &&
    eventName === 'PostToolUse' &&
    (isCompletedBookkeeping || finishedBackgroundCommand)
  // Stop between tools reports fullyIdle=false without background work; stay working until truly idle or held.
  const leadState = preservesDoneLead
    ? 'done'
    : eventName === 'PreToolUse' && isAntigravityFeedbackTool(toolName)
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
  if (
    ((eventName === 'Stop' && !stopStillBusy) || preservesDoneLead) &&
    payload?.state === 'done' &&
    subagents.length === 0 &&
    (paneState.commands?.size ?? 0) === 0
  ) {
    if (transcriptPath) {
      state.antigravityCompletedTranscriptByPaneKey.set(paneKey, transcriptPath)
    }
  }
  return payload
}
