import {
  isAntigravityInSessionChildHook,
  type AntigravityTranscriptOrigin
} from './antigravity-hook-identity'
import {
  antigravityHasPendingLaunch,
  trackAntigravityBackgroundCommand
} from './antigravity-pane-state'
import { trackAntigravityLaunch } from './antigravity-launch-state'
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
  isAntigravityAgentCoordinationTool,
  isAntigravityFeedbackTool,
  isAntigravityHelperSpawnCall,
  isAntigravityStopStillBusy,
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
  if (isAntigravityFeedbackTool(toolName)) {
    return null
  }
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
): ParsedAgentStatusPayload | { liveness: ParsedAgentStatusPayload } | null {
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

  // A child Stop without its conversation id must not run the root's idle-Stop cleanup.
  if (existingPaneState?.rootConversationId && !conversationId && origin === 'child') {
    return null
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

  const { toolCallId, toolName, toolInputSource } = readAntigravityToolCall(hookPayload)
  const toolPhase =
    eventName === 'PreToolUse' || eventName === 'PostToolUse' ? eventName : undefined
  const launchPhase = isAntigravityHelperSpawnCall(toolName, toolInputSource)
    ? toolPhase
    : undefined
  const isCompletedBookkeeping = Boolean(
    transcriptPath &&
    eventName !== 'Stop' &&
    state.antigravityCompletedTranscriptByPaneKey.get(paneKey) === transcriptPath
  )
  const completedBookkeepingOnly =
    isCompletedBookkeeping &&
    eventName !== 'PreInvocation' &&
    launchPhase !== 'PostToolUse' &&
    !existingPaneState?.verifiedChildren.size &&
    (!existingPaneState || !antigravityHasPendingLaunch(existingPaneState))
  if (
    completedBookkeepingOnly &&
    (!launchPhase ||
      !existingPaneState?.rootConversationId ||
      existingPaneState.rootConversationId !== conversationId)
  ) {
    // Ignore bookkeeping after Stop so finished rows do not resurrect.
    return null
  }

  const paneState = getOrCreateAntigravityPaneState(state, paneKey)
  if (
    conversationId &&
    !paneState.rootConversationId &&
    // An unreadable root transcript must not leave its subagents to finish the run as cold children.
    (origin === 'root' ||
      (origin === 'unknown' &&
        (Boolean(promptText || readFirstString(hookPayload, ['lastUserInput'])) ||
          isAntigravityAgentCoordinationTool(toolName))))
  ) {
    paneState.rootConversationId = conversationId
  }
  const rootHook = conversationId !== undefined && conversationId === paneState.rootConversationId
  const step = hookPayload.stepIdx
  const toolStep =
    typeof step === 'number' && Number.isSafeInteger(step) && step >= 0 ? step : undefined
  if (launchPhase && toolName && rootHook) {
    const disposition = trackAntigravityLaunch(
      paneState,
      launchPhase,
      toolStep,
      toolCallId,
      toolName,
      toolInputSource,
      origin === 'child' ? undefined : transcriptPath,
      completedBookkeepingOnly
    )
    if (disposition === 'stale') {
      return null
    }
    if (disposition === 'hold') {
      const payload = buildAntigravityFoldedStatusPayload(state, paneKey, paneState, now)
      return payload ? { liveness: payload } : null
    }
  } else {
    paneState.currentLaunch = undefined
  }
  if (rootHook && origin !== 'child' && toolPhase && toolName && toolStep !== undefined) {
    paneState.rootStepFrontier = Math.max(paneState.rootStepFrontier ?? -1, toolStep)
  }
  if (eventName === 'PreInvocation') {
    state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  }
  paneState.leadObservedAt = now
  const brainDir = resolveAntigravityBrainDirectory(hookPayload, transcriptPath)
  if (brainDir && paneState.rootConversationId === conversationId) {
    if (
      paneState.rootBrainDir !== brainDir ||
      (transcriptPath && paneState.rootTranscriptPath !== transcriptPath)
    ) {
      paneState.brainCache = createAntigravityBrainCache()
      paneState.rootTranscriptPath = transcriptPath
    }
    paneState.rootBrainDir = brainDir
    paneState.rootTranscriptPath = transcriptPath ?? paneState.rootTranscriptPath
  }

  const resetsTurn = isNewTurnEvent('antigravity', eventName)
  const stopStillBusy = eventName === 'Stop' && isAntigravityStopStillBusy(hookPayload)
  const idleBookkeeping = paneState.rootStop === 'idle' && eventName === 'PostToolUse'
  if (
    !idleBookkeeping &&
    (eventName !== 'Stop' || (!stopStillBusy && paneState.rootStop !== 'idle'))
  ) {
    paneState.helpersIdleAt = undefined
  }
  if (!idleBookkeeping) {
    paneState.rootStop = eventName === 'Stop' ? (stopStillBusy ? 'busy' : 'idle') : undefined
  }
  const finishedBackgroundCommand = trackAntigravityBackgroundCommand(
    paneState,
    eventName,
    conversationId,
    hookPayload
  )

  const rawModel = readFirstString(hookPayload, ['modelName', 'model'])
  if (rawModel || (resetsTurn && paneState.leadModel === undefined)) {
    const resolvedModel = normalizeAntigravityModel(rawModel)
    paneState.leadModel = resolvedModel ?? paneState.leadModel
    if (resolvedModel) {
      paneState.leadModelSince = undefined
      paneState.leadModelFromStep = undefined
    } else if (resetsTurn) {
      const steps = hookPayload.initialNumSteps
      paneState.leadModelSince = now
      paneState.leadModelFromStep = typeof steps === 'number' ? steps : undefined
    }
  }

  if (eventName === 'Stop' && !stopStillBusy) {
    paneState.commands?.clear()
  }
  const subagents = reconcileAntigravityActiveSubagents(paneState, now)
  const hasBackgroundHold =
    subagents.length > 0 ||
    antigravityHasPendingLaunch(paneState) ||
    (paneState.commands?.size ?? 0) > 0 ||
    paneState.helpersIdleAt !== undefined
  const preservesDoneLead =
    paneState.leadState === 'done' &&
    !resetsTurn &&
    eventName === 'PostToolUse' &&
    (idleBookkeeping || isCompletedBookkeeping || finishedBackgroundCommand)
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
