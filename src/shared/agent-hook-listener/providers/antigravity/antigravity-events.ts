import {
  isAntigravityInSessionChildHook,
  type AntigravityTranscriptOrigin
} from './antigravity-hook-identity'
import { buildAntigravityFoldedStatusPayload } from './antigravity-parent-status'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../../agent-status/contracts/agent-status-types'
import { continueMainAgentStatus } from '../../../agent-status/lifecycle/agent-lead-status-fold'
import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
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
  normalizeAntigravityModel,
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
): boolean {
  const { toolName, toolInputSource } = readAntigravityToolCall(hookPayload)
  const stepIdx = hookPayload.stepIdx
  if (
    toolName !== 'run_command' ||
    !conversationId ||
    typeof stepIdx !== 'number' ||
    (eventName !== 'PreToolUse' && eventName !== 'PostToolUse')
  ) {
    return false
  }
  const key = `${conversationId}:${stepIdx}`
  if (eventName === 'PostToolUse') {
    return paneState.commands?.delete(key) === true
  }
  if (isRecord(toolInputSource) && toolInputSource.IsDaemon === true) {
    return false
  }
  paneState.commands = (paneState.commands ?? new Set()).add(key)
  return false
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
    const known =
      existingPaneState.children.has(conversationId) ||
      existingPaneState.diskSubagents?.some((child) => child.conversationId === conversationId) ||
      existingPaneState.swarmMembers?.some((member) => member.conversationId === conversationId)
    if (!known && (transcriptPath || !existingPaneState.discoversChildren)) {
      return null
    }
    trackAntigravityBackgroundCommand(existingPaneState, eventName, conversationId, hookPayload)
    recordAntigravityChildHook(existingPaneState, conversationId, eventName, hookPayload, now)
    const subagents = reconcileAntigravityActiveSubagents(existingPaneState, now)
    if (subagents.length === 0 && (existingPaneState.commands?.size ?? 0) === 0) {
      existingPaneState.helpersIdleAt ??= now
    } else {
      existingPaneState.helpersIdleAt = undefined
    }
    if (!existingPaneState.rootBrainDir) {
      return null
    }
    return buildAntigravityFoldedStatusPayload(state, paneKey, existingPaneState, now, {
      subagents
    })
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

  const hookModel = normalizeAntigravityModel(readFirstString(hookPayload, ['modelName', 'model']))
  paneState.leadModel = hookModel ?? paneState.leadModel

  if (eventName === 'Stop' && !stopStillBusy) {
    paneState.retiredBefore = now
    for (const id of paneState.children.keys()) {
      paneState.retiredChildren.add(id)
    }
    paneState.children.clear()
    paneState.commands?.clear()
    paneState.diskSubagents = []
    paneState.swarmMembers = []
    paneState.discoversChildren = false
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
