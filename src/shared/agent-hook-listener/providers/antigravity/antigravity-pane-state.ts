import type { AgentStatusState } from '../../../agent-status/contracts/agent-status-types'
import { readFirstString } from '../../interactive-tool'
import type { HookListenerState } from '../../listener-state'
import { extractToolFields } from '../../provider-event-routing'
import {
  createAntigravityBrainCache,
  normalizeAntigravityModel,
  readAntigravityChildStartedAt,
  readAntigravityChildTranscriptTail,
  readAntigravityTranscriptModel,
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
  model?: string
  toolName?: string
  toolInput?: string
}

export type AntigravityPaneChildState = {
  rootConversationId?: string
  rootBrainDir?: string
  hasSpawnedHelper?: boolean
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
  transcriptPath: string | undefined,
  now: number
): void {
  const initialStart =
    paneState.children.get(childId)?.startedAt ??
    (paneState.rootBrainDir
      ? readAntigravityChildStartedAt(paneState.rootBrainDir, childId)
      : undefined) ??
    now
  const tracked = getOrCreateTrackedChild(paneState, childId, initialStart)
  const hookModel = normalizeAntigravityModel(readFirstString(hookPayload, ['modelName', 'model']))
  if (hookModel) {
    tracked.model = hookModel
  } else if (!tracked.model && transcriptPath) {
    tracked.model = readAntigravityTranscriptModel(transcriptPath)
  }
  if (typeof hookPayload.stepIdx === 'number') {
    tracked.hookStepIdx = hookPayload.stepIdx
  }

  if (eventName === 'PreInvocation' || eventName === 'PostInvocation') {
    if (eventName === 'PreInvocation') {
      tracked.toolName = undefined
      tracked.toolInput = undefined
      if (paneState.rootBrainDir) {
        const tail = readAntigravityChildTranscriptTail(paneState.rootBrainDir, childId)
        tracked.settledStepAtTurnStart = tail?.settled ? tail.stepIndex : undefined
      }
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
  }
}
