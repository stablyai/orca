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
): void {
  if (paneState.retiredChildren.has(childId) && eventName !== 'PreInvocation') {
    return
  }
  if (!paneState.awaitingInitialHelperDiscovery?.has(childId)) {
    paneState.awaitingInitialHelperDiscovery = undefined
  }
  const initialStart =
    paneState.children.get(childId)?.startedAt ??
    paneState.transcriptTails.get(childId)?.createdAtMs ??
    now
  const tracked = getOrCreateTrackedChild(paneState, childId, initialStart)
  const hookModel = normalizeAntigravityModel(readFirstString(hookPayload, ['modelName', 'model']))
  if (hookModel) {
    tracked.hookModel = hookModel
  }
  if (typeof hookPayload.stepIdx === 'number') {
    tracked.hookStepIdx = hookPayload.stepIdx
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
    return
  }
  if (eventName === 'PreToolUse') {
    const tool = extractToolFields('antigravity', 'PreToolUse', hookPayload)
    tracked.sawToolHook = true
    tracked.toolName = tool.toolName
    tracked.toolInput = tool.toolInput
    tracked.hookState = isAntigravityFeedbackTool(tool.toolName) ? 'waiting' : 'working'
    return
  }
  if (eventName === 'PostToolUse') {
    if (tracked.hookState === 'done') {
      return
    }
    tracked.sawToolHook = true
    tracked.toolName = undefined
    tracked.toolInput = undefined
    tracked.hookState = 'working'
    return
  }
  if (eventName === 'Stop') {
    tracked.toolName = undefined
    tracked.toolInput = undefined
    tracked.hookState = isAntigravityStopStillBusy(hookPayload) ? 'working' : 'done'
    if (tracked.hookState === 'done') {
      paneState.retiredChildren.add(childId)
      paneState.children.delete(childId)
      for (const key of paneState.commands ?? []) {
        if (key.startsWith(`${childId}:`)) {
          paneState.commands?.delete(key)
        }
      }
    }
  }
}
