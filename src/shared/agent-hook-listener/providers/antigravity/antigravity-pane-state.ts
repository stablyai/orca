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

export type AntigravityLaunch = {
  callId: string
  toolName: string
  swarmSize?: number
  phases: number
}

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
  pendingLaunches: Map<number | undefined, AntigravityLaunch | null>
  settledLaunches: Map<number, AntigravityLaunch>
  launchStepsByCall: Map<string, number>
  currentLaunch?: AntigravityLaunch
  rootStepFrontier?: number
  pendingOlderLaunchStep?: number
  expectedChildren: Set<string>
  helpersIdleAt?: number
  /** The relay dropped this pane's roster to fit a frame, so its children are unknown, not gone. */
  relayRosterShed?: true
  /** The root can stop idle while its children still have work. */
  rootStop?: 'busy' | 'idle'
  leadState?: AgentStatusState
  leadStateStartedAt?: number
  leadObservedAt?: number
  discoveryObservedAt?: number
  leadModel?: string
  /** Start of an automatic-model turn whose transcript has not reported its model yet. */
  leadModelSince?: number
  /** agy's step count when that turn began; its own transcript lines carry later step indices. */
  leadModelFromStep?: number
  commands?: Set<number>
  children: Map<string, TrackedAntigravityChild>
  verifiedChildren: Set<string>
  /** Retired child ids, and whether each was proven ours; descriptors never change, so the proof holds. */
  retiredChildren: Map<string, boolean>
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
      pendingLaunches: new Map(),
      settledLaunches: new Map(),
      launchStepsByCall: new Map(),
      expectedChildren: new Set(),
      verifiedChildren: new Set(),
      retiredChildren: new Map(),
      brainCache: createAntigravityBrainCache()
    }
    state.antigravityChildWorkByPaneKey.set(paneKey, pane)
  }
  return pane
}
export function retireAntigravityChild(pane: AntigravityPaneChildState, id: string): void {
  const verified = pane.verifiedChildren.delete(id)
  const expected = pane.expectedChildren.delete(id)
  pane.retiredChildren.delete(id)
  pane.retiredChildren.set(id, verified)
  if (pane.retiredChildren.size > 4096) {
    pane.retiredChildren.delete(pane.retiredChildren.keys().next().value!)
  }
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
  if (verified || expected) {
    recordAntigravityHelpersDrain(pane)
  }
}

export function antigravityHasPendingLaunch(pane: AntigravityPaneChildState): boolean {
  return pane.pendingLaunches.size > 0 || pane.expectedChildren.size > 0
}

export function antigravityHelpersSettled(pane: AntigravityPaneChildState): boolean {
  return (
    pane.verifiedChildren.size === 0 && !pane.commands?.size && !antigravityHasPendingLaunch(pane)
  )
}

export function recordAntigravityHelpersDrain(pane: AntigravityPaneChildState): void {
  if (antigravityHelpersSettled(pane)) {
    pane.helpersIdleAt ??= Date.now()
  }
}

export function recordAntigravityChildHook(
  pane: AntigravityPaneChildState,
  id: string,
  eventName: unknown,
  payload: Record<string, unknown>,
  now: number
): void {
  if (
    pane.rootStop === 'idle' &&
    !pane.verifiedChildren.has(id) &&
    !pane.expectedChildren.has(id) &&
    pane.pendingLaunches.size === 0
  ) {
    return
  }
  if (pane.retiredChildren.has(id) && eventName !== 'PreInvocation') {
    return
  }
  pane.discoveryObservedAt = now
  const existing = pane.children.get(id)
  if (eventName === 'Stop' && !isAntigravityStopStillBusy(payload)) {
    if (pane.verifiedChildren.has(id) || pane.expectedChildren.has(id)) {
      retireAntigravityChild(pane, id)
    } else if (!existing?.stopped) {
      const child: TrackedAntigravityChild = existing ?? {
        id,
        startedAt: now,
        revision: 0,
        state: 'working'
      }
      child.stopped = true
      child.revision++
      pane.children.set(id, child)
      pane.dirty = true
    }
    return
  }
  if (existing?.stopped && eventName !== 'PreInvocation') {
    return
  }
  const provenBefore = pane.retiredChildren.get(id) === true
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
  if (provenBefore) {
    verifyAntigravityChild(pane, id)
  }
  if (pane.verifiedChildren.has(id)) {
    pane.helpersIdleAt = undefined
  }
}
export function verifyAntigravityChild(pane: AntigravityPaneChildState, id: string): void {
  pane.expectedChildren.delete(id)
  if (pane.verifiedChildren.has(id)) {
    return
  }
  pane.verifiedChildren.add(id)
  pane.helpersIdleAt = undefined
  // A subagent proven after the root's busy Stop is the work that Stop waited on, so the lead is done.
  if (pane.rootStop === 'busy' && pane.leadState === 'working') {
    pane.leadState = 'done'
    pane.leadStateStartedAt = Date.now()
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
