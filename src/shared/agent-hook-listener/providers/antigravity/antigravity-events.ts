import {
  isAntigravityInSessionChildHook,
  type AntigravityTranscriptOrigin
} from './antigravity-hook-identity'
import {
  retireAntigravityChild,
  settleAntigravityHelperSpawn,
  trackAntigravityBackgroundCommand
} from './antigravity-pane-state'
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
  isAntigravityHelperSpawnCall,
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
import { antigravityTranscriptFilePath } from './antigravity-child-transcript'

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
    // After the root's final idle Stop nothing would end a reopened row, so late child hooks stay ignored.
    if (existingPaneState.rootStop === 'idle') {
      return null
    }
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
  paneState.leadObservedAt = now
  const { toolName, toolInputSource } = readAntigravityToolCall(hookPayload)
  const spawnsHelpers = isAntigravityHelperSpawnCall(toolName, toolInputSource)
  const brainDir = resolveAntigravityBrainDirectory(hookPayload, transcriptPath)
  if (
    conversationId &&
    !paneState.rootConversationId &&
    // An unreadable root transcript must not leave its subagents to finish the run as cold children.
    (origin === 'root' ||
      (origin === 'unknown' &&
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
  paneState.rootStop = eventName === 'Stop' ? (stopStillBusy ? 'busy' : 'idle') : undefined
  if (resetsTurn || (eventName === 'Stop' && !stopStillBusy)) {
    paneState.pendingHelperSpawns = undefined
  }
  if (
    (eventName === 'PreToolUse' || eventName === 'PostToolUse') &&
    isAntigravitySubagentTool(toolName)
  ) {
    paneState.discoversChildren = true
  }
  if (eventName === 'PreToolUse' && spawnsHelpers) {
    paneState.pendingHelperSpawns = (paneState.pendingHelperSpawns ?? 0) + 1
  } else if (
    eventName === 'PostToolUse' &&
    spawnsHelpers &&
    readFirstString(hookPayload, ['error'])
  ) {
    settleAntigravityHelperSpawn(paneState)
  }
  const finishedBackgroundCommand = trackAntigravityBackgroundCommand(
    paneState,
    eventName,
    conversationId,
    hookPayload
  )

  const rawModel = readFirstString(hookPayload, ['modelName', 'model'])
  if (rawModel) {
    const resolvedModel = normalizeAntigravityModel(rawModel)
    paneState.leadModel = resolvedModel ?? paneState.leadModel
    if (resolvedModel) {
      paneState.leadModelSince = undefined
    } else if (resetsTurn) {
      paneState.leadModelSince = now
    }
  }

  if (eventName === 'Stop' && !stopStillBusy) {
    for (const id of paneState.children.keys()) {
      retireAntigravityChild(paneState, id)
    }
    paneState.children.clear()
    paneState.verifiedChildren.clear()
    const rootTranscript =
      paneState.rootBrainDir && paneState.rootConversationId
        ? antigravityTranscriptFilePath(paneState.rootBrainDir, paneState.rootConversationId)
        : undefined
    const rootCursor = rootTranscript && paneState.brainCache.transcripts.get(rootTranscript)
    paneState.brainCache = createAntigravityBrainCache()
    // Keep the root transcript's read position so later automatic turns read only new lines.
    if (rootTranscript && rootCursor) {
      paneState.brainCache.transcripts.set(rootTranscript, rootCursor)
    }
    paneState.commands?.clear()
    paneState.discoversChildren = false
    paneState.dirty = false
    paneState.helpersIdleAt = undefined
  }
  const subagents = reconcileAntigravityActiveSubagents(paneState, now)
  const hasBackgroundHold =
    subagents.length > 0 ||
    paneState.pendingHelperSpawns !== undefined ||
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
