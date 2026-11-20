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
  /** Tracked again after it retired: its proof does not settle a newer spawn. */
  wokeAgain?: true
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
  /** Helper spawns the root started whose child no poll has proven yet. */
  pendingHelperSpawns?: number
  helpersIdleAt?: number
  /** The relay dropped this pane's roster to fit a frame, so its children are unknown, not gone. */
  relayRosterShed?: true
  /** How the root's last hook stopped: busy while background work runs, idle at the run's end. */
  rootStop?: 'busy' | 'idle'
  leadState?: AgentStatusState
  leadStateStartedAt?: number
  leadObservedAt?: number
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
  if (verified && antigravityHelpersSettled(pane)) {
    pane.helpersIdleAt = Date.now()
  }
}
/** No proven child, tracked command or unsettled spawn is left, so the parent's grace may start. */
export function antigravityHelpersSettled(pane: AntigravityPaneChildState): boolean {
  return (
    pane.verifiedChildren.size === 0 &&
    !pane.commands?.size &&
    pane.pendingHelperSpawns === undefined
  )
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
  const provenBefore = pane.retiredChildren.get(id) === true
  const wokeAgain = pane.retiredChildren.delete(id) && !existing ? true : undefined
  const child: TrackedAntigravityChild = existing ?? {
    id,
    startedAt: now,
    revision: 0,
    state: 'working',
    wokeAgain
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
  if (!pane.rootBrainDir || (wokeAgain && provenBefore)) {
    verifyAntigravityChild(pane, id)
  }
  if (pane.verifiedChildren.has(id)) {
    pane.helpersIdleAt = undefined
  }
}
/** Proof of ownership settles one pending spawn, so each spawn holds the parent until its child is proven. */
export function verifyAntigravityChild(pane: AntigravityPaneChildState, id: string): void {
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
  if (!pane.children.get(id)?.wokeAgain) {
    settleAntigravityHelperSpawn(pane)
  }
}
/** A spawn settles when its child is proven or when agy reports the spawn failed. */
export function settleAntigravityHelperSpawn(pane: AntigravityPaneChildState): void {
  const pending = (pane.pendingHelperSpawns ?? 0) - 1
  pane.pendingHelperSpawns = pending > 0 ? pending : undefined
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
