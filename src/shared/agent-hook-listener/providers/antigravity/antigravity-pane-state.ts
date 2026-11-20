import type { AgentStatusState } from '../../../agent-status/contracts/agent-status-types'
import {
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  normalizeOptionalField
} from '../../../agent-status/contracts/agent-status-field-normalization'
import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import { readFirstString } from '../../interactive-tool'
import type { HookListenerState } from '../../listener-state'
import { extractToolFields } from '../../provider-event-routing'
import {
  createAntigravityBrainCache,
  normalizeAntigravityModel,
  antigravityChildDescriptorPath,
  type AntigravityBrainCache
} from './antigravity-brain-metadata'
import { isAntigravityFeedbackTool, isAntigravityStopStillBusy } from './antigravity-event-rules'
import { readAntigravityToolCall } from './antigravity-tool-fields'
import { antigravityTranscriptFilePath } from './antigravity-child-transcript'

export type TrackedAntigravityChild = {
  id: string
  startedAt: number
  revision: number
  state: 'working' | 'waiting'
  stopped?: true
  description?: string
  agentType?: string
  model?: string
  modelAuto?: true
  toolName?: string
  toolInput?: string
}
export type AntigravityPaneChildState = {
  rootConversationId?: string
  rootBrainDir?: string
  rootTranscriptPath?: string
  discoversChildren?: boolean
  awaitingInitialHelperDiscovery?: true
  helpersIdleAt?: number
  rootStoppedIdle?: true
  leadState?: AgentStatusState
  leadStateStartedAt?: number
  leadObservedAt?: number
  leadModel?: string
  leadModelAuto?: true
  commands?: Set<number>
  children: Map<string, TrackedAntigravityChild>
  verifiedChildren: Set<string>
  retiredChildren: Set<string>
  brainCache: AntigravityBrainCache
  dirty?: boolean
}
export function getOrCreateAntigravityPaneState(
  state: HookListenerState,
  paneKey: string
): AntigravityPaneChildState {
  let pane = state.antigravityChildWorkByPaneKey.get(paneKey)
  if (!pane) {
    pane = {
      children: new Map(),
      verifiedChildren: new Set(),
      retiredChildren: new Set(),
      brainCache: createAntigravityBrainCache()
    }
    state.antigravityChildWorkByPaneKey.set(paneKey, pane)
  }
  return pane
}
export function retireAntigravityChild(pane: AntigravityPaneChildState, id: string): void {
  pane.retiredChildren.delete(id)
  pane.retiredChildren.add(id)
  if (pane.retiredChildren.size > 4096) {
    pane.retiredChildren.delete(pane.retiredChildren.values().next().value!)
  }
  const verified = pane.verifiedChildren.delete(id)
  pane.children.delete(id)
  if (pane.rootBrainDir) {
    const transcript = antigravityTranscriptFilePath(pane.rootBrainDir, id)
    if (transcript) {
      pane.brainCache.transcripts.delete(transcript)
    }
    const path = antigravityChildDescriptorPath(pane.rootBrainDir, id)
    if (path) {
      pane.brainCache.jsonFiles.delete(path)
    }
  }
  pane.dirty = true
  if (verified && pane.verifiedChildren.size === 0 && !pane.commands?.size) {
    pane.helpersIdleAt = Date.now()
  }
}
export function recordAntigravityChildHook(
  pane: AntigravityPaneChildState,
  id: string,
  eventName: unknown,
  payload: Record<string, unknown>,
  now: number
): void {
  if (pane.retiredChildren.has(id) && eventName !== 'PreInvocation') {
    return
  }
  const existing = pane.children.get(id)
  if (eventName === 'Stop' && !isAntigravityStopStillBusy(payload)) {
    if (existing && pane.verifiedChildren.has(id)) {
      retireAntigravityChild(pane, id)
    } else if (existing && !existing.stopped) {
      // Retire only after the poll proves ownership, so a verified finish still starts the parent's grace.
      existing.stopped = true
      existing.revision++
      pane.dirty = true
    }
    return
  }
  if (existing?.stopped && eventName !== 'PreInvocation') {
    return
  }
  pane.retiredChildren.delete(id)
  const child: TrackedAntigravityChild = existing ?? {
    id,
    startedAt: now,
    revision: 0,
    state: 'working'
  }
  if (eventName === 'PreInvocation' && existing) {
    existing.stopped = undefined
    existing.revision++
  }
  const tool =
    eventName === 'PreToolUse' ? extractToolFields('antigravity', eventName, payload) : undefined
  const toolName = tool?.toolName
  const toolInput = normalizeOptionalField(tool?.toolInput, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  const rawModel = readFirstString(payload, ['modelName', 'model'])
  const resolvedModel = normalizeAntigravityModel(rawModel)
  const model = resolvedModel ?? child.model
  const modelAuto = rawModel ? (resolvedModel ? undefined : true) : child.modelAuto
  const state = isAntigravityFeedbackTool(toolName) ? 'waiting' : 'working'
  if (
    !existing ||
    child.state !== state ||
    child.model !== model ||
    child.modelAuto !== modelAuto ||
    child.toolName !== toolName ||
    child.toolInput !== toolInput
  ) {
    Object.assign(child, {
      state,
      model,
      modelAuto,
      toolName,
      toolInput,
      revision: child.revision + 1
    })
    pane.children.set(id, child)
    pane.dirty = true
  }
  if (!pane.rootBrainDir) {
    pane.verifiedChildren.add(id)
  }
  if (pane.verifiedChildren.has(id)) {
    pane.helpersIdleAt = undefined
    pane.awaitingInitialHelperDiscovery = undefined
  }
}
export function trackAntigravityBackgroundCommand(
  pane: AntigravityPaneChildState,
  eventName: unknown,
  id: string | undefined,
  payload: Record<string, unknown>
): boolean {
  const { toolName, toolInputSource } = readAntigravityToolCall(payload)
  const stepIdx = payload.stepIdx
  if (
    toolName !== 'run_command' ||
    id !== pane.rootConversationId ||
    typeof stepIdx !== 'number' ||
    (eventName !== 'PreToolUse' && eventName !== 'PostToolUse')
  ) {
    return false
  }
  if (eventName === 'PostToolUse') {
    return pane.commands?.delete(stepIdx) === true
  }
  if (isRecord(toolInputSource) && toolInputSource.IsDaemon === true) {
    return false
  }
  pane.commands = (pane.commands ?? new Set()).add(stepIdx)
  return false
}
