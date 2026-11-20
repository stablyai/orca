import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import { readAntigravityToolCall } from './antigravity-tool-fields'
import { join } from 'node:path'
import type { AgentStatusState } from '../../../agent-status/contracts/agent-status-types'
import { readFirstString } from '../../interactive-tool'
import type { HookListenerState } from '../../listener-state'
import { extractToolFields } from '../../provider-event-routing'
import {
  createAntigravityBrainCache,
  normalizeAntigravityModel,
  type AntigravityDiskSubagent,
  type AntigravityDiskSwarmMember,
  type AntigravityChildTranscriptTail,
  type AntigravityBrainCache
} from './antigravity-brain-metadata'
import { isAntigravityFeedbackTool, isAntigravityStopStillBusy } from './antigravity-event-rules'

export type TrackedAntigravityChild = {
  id: string
  startedAt: number
  hookState?: 'working' | 'waiting' | 'done'
  sawToolHook?: boolean
  hookStepIdx?: number
  settledStepAtTurnStart?: number
  lastMemberWakeMode?: string
  lastMemberModel?: string
  hookModel?: string
  fallbackModel?: string
  toolName?: string
  toolInput?: string
}

export type AntigravityPaneChildState = {
  rootConversationId?: string
  rootBrainDir?: string
  rootTranscriptPath?: string
  discoversChildren?: boolean
  diskSubagents?: AntigravityDiskSubagent[]
  swarmMembers?: AntigravityDiskSwarmMember[]
  transcriptTails: Map<string, AntigravityChildTranscriptTail>
  retiredChildren: Set<string>
  retiredBefore?: number
  awaitingInitialHelperDiscovery?: Set<string>
  helpersIdleAt?: number
  leadState?: AgentStatusState
  leadStateStartedAt?: number
  leadModel?: string
  commands?: Set<string>
  children: Map<string, TrackedAntigravityChild>
  brainCache: AntigravityBrainCache
}

export function getOrCreateAntigravityPaneState(
  state: HookListenerState,
  paneKey: string
): AntigravityPaneChildState {
  let existing = state.antigravityChildWorkByPaneKey.get(paneKey)
  if (!existing) {
    existing = {
      children: new Map(),
      transcriptTails: new Map(),
      retiredChildren: new Set(),
      brainCache: createAntigravityBrainCache()
    }
    state.antigravityChildWorkByPaneKey.set(paneKey, existing)
  }
  return existing
}

export function getOrCreateTrackedChild(
  paneState: AntigravityPaneChildState,
  childId: string,
  startedAt: number
): TrackedAntigravityChild {
  let tracked = paneState.children.get(childId)
  if (!tracked) {
    tracked = { id: childId, startedAt }
    paneState.children.set(childId, tracked)
  }
  return tracked
}

export function recordAntigravityChildHook(
  paneState: AntigravityPaneChildState,
  childId: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  now: number
): boolean {
  if (paneState.retiredChildren.has(childId) && eventName !== 'PreInvocation') {
    return false
  }
  if (!paneState.awaitingInitialHelperDiscovery?.has(childId)) {
    paneState.awaitingInitialHelperDiscovery = undefined
  }
  const initialStart =
    paneState.children.get(childId)?.startedAt ??
    paneState.transcriptTails.get(childId)?.createdAtMs ??
    now
  const old = paneState.children.get(childId)
  const before = old ? [old.hookState, old.hookModel, old.toolName, old.toolInput] : undefined
  const tracked = getOrCreateTrackedChild(paneState, childId, initialStart)
  const changed = (): boolean =>
    !before ||
    before[0] !== tracked.hookState ||
    before[1] !== tracked.hookModel ||
    before[2] !== tracked.toolName ||
    before[3] !== tracked.toolInput
  const hookModel = normalizeAntigravityModel(readFirstString(hookPayload, ['modelName', 'model']))
  if (hookModel) {
    tracked.hookModel = hookModel
  }
  if (typeof hookPayload.stepIdx === 'number') {
    tracked.hookStepIdx = hookPayload.stepIdx
  }

  if (
    eventName === 'PostInvocation' &&
    tracked.lastMemberWakeMode === 'mentions' &&
    tracked.hookState === undefined
  ) {
    return false
  }
  if (eventName === 'PreInvocation' || eventName === 'PostInvocation') {
    if (eventName === 'PreInvocation') {
      paneState.retiredChildren.delete(childId)
      tracked.toolName = undefined
      tracked.toolInput = undefined
      const tail = paneState.transcriptTails.get(childId)
      tracked.settledStepAtTurnStart = tail?.settled ? tail.stepIndex : undefined
    }
    tracked.hookState = 'working'
    return changed()
  }
  if (eventName === 'PreToolUse') {
    const tool = extractToolFields('antigravity', 'PreToolUse', hookPayload)
    tracked.sawToolHook = true
    tracked.toolName = tool.toolName
    tracked.toolInput = tool.toolInput
    tracked.hookState = isAntigravityFeedbackTool(tool.toolName) ? 'waiting' : 'working'
    return changed()
  }
  if (eventName === 'PostToolUse') {
    if (
      tracked.hookState === 'done' ||
      (tracked.lastMemberWakeMode === 'mentions' && tracked.hookState === undefined)
    ) {
      return false
    }
    tracked.sawToolHook = true
    tracked.toolName = undefined
    tracked.toolInput = undefined
    tracked.hookState = 'working'
    return changed()
  }
  if (eventName === 'Stop') {
    tracked.toolName = undefined
    tracked.toolInput = undefined
    tracked.hookState = isAntigravityStopStillBusy(hookPayload) ? 'working' : 'done'
    if (tracked.hookState === 'done') {
      retireAntigravityChild(paneState, childId)
    }
  }
  return changed()
}

export function retireAntigravityChild(pane: AntigravityPaneChildState, id: string): void {
  pane.retiredChildren.delete(id)
  pane.retiredChildren.add(id)
  if (pane.retiredChildren.size > 4096) {
    pane.retiredChildren.delete(pane.retiredChildren.values().next().value!)
  }
  const child = pane.children.get(id)
  if (child?.lastMemberWakeMode !== undefined) {
    child.hookState = 'done'
    child.toolName = undefined
    child.toolInput = undefined
  } else {
    pane.children.delete(id)
  }
  pane.transcriptTails.delete(id)
  if (pane.rootBrainDir) {
    pane.brainCache.transcripts.delete(
      join(pane.rootBrainDir, '..', id, '.system_generated', 'logs', 'transcript.jsonl')
    )
    pane.brainCache.jsonFiles.delete(
      join(pane.rootBrainDir, '.system_generated', 'subagents', `${id}.json`)
    )
  }
  for (const key of pane.commands ?? []) {
    if (key.startsWith(`${id}:`)) {
      pane.commands?.delete(key)
    }
  }
}

/** agy sends a backgrounded run_command's PostToolUse only when the command ends; daemons are never expected to. */
export function trackAntigravityBackgroundCommand(
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
