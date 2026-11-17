import type { AgentSubagentSnapshot } from '../../../agent-status/contracts/agent-status-subagent-snapshot'
import {
  readAntigravityBrainSubagents,
  readAntigravityChildStartedAt,
  readAntigravityChildTranscriptModel,
  readAntigravityChildTranscriptTail,
  readAntigravitySwarmMembers,
  type AntigravityChildTranscriptTail,
  type AntigravityDiskSubagent,
  type AntigravityDiskSwarmMember
} from './antigravity-brain-metadata'
import { isAntigravityFeedbackTool } from './antigravity-event-rules'
import {
  getOrCreateAntigravityPaneState,
  getOrCreateTrackedChild,
  recordAntigravityChildHook,
  type AntigravityPaneChildState,
  type TrackedAntigravityChild
} from './antigravity-pane-state'

export {
  getOrCreateAntigravityPaneState,
  recordAntigravityChildHook,
  type AntigravityPaneChildState
}

function resolveChildModel(
  rootBrainDir: string | undefined,
  childId: string,
  tracked: TrackedAntigravityChild,
  memberModel: string | undefined,
  tail: AntigravityChildTranscriptTail | undefined
): string | undefined {
  if (tracked.model) {
    return tracked.model
  }
  const resolved = memberModel ?? tail?.model
  if (resolved) {
    tracked.model = resolved
    return resolved
  }
  if (!rootBrainDir) {
    return undefined
  }
  const tailModel = readAntigravityChildTranscriptModel(rootBrainDir, childId)
  if (tailModel) {
    tracked.model = tailModel
  }
  return tailModel
}

function buildActiveChildSnapshot(params: {
  paneState: AntigravityPaneChildState
  childId: string
  description: string
  agentType: string
  memberModel?: string
  tail?: AntigravityChildTranscriptTail
  fallbackStart?: number
  now: number
}): AgentSubagentSnapshot {
  const { paneState, childId, description, agentType, memberModel, tail, fallbackStart, now } =
    params
  const rootBrainDir = paneState.rootBrainDir
  const initialStart =
    paneState.children.get(childId)?.startedAt ??
    (rootBrainDir ? readAntigravityChildStartedAt(rootBrainDir, childId) : undefined) ??
    fallbackStart ??
    now
  const tracked = getOrCreateTrackedChild(paneState, childId, initialStart)
  const toolName = tracked.sawToolHook ? tracked.toolName : (tracked.toolName ?? tail?.toolName)
  const toolInput = tracked.sawToolHook ? tracked.toolInput : (tracked.toolInput ?? tail?.toolInput)
  const waiting = tracked.hookState === 'waiting' || isAntigravityFeedbackTool(toolName)
  return {
    id: childId,
    description,
    agentType,
    model: resolveChildModel(rootBrainDir, childId, tracked, memberModel, tail),
    toolName,
    toolInput,
    state: waiting ? 'waiting' : 'working',
    startedAt: tracked.startedAt
  }
}

function reconcileSwarmMemberSnapshot(
  paneState: AntigravityPaneChildState,
  member: AntigravityDiskSwarmMember,
  now: number
): AgentSubagentSnapshot | null {
  if (member.killed || member.desiredState === 'KILLED' || member.phase !== 'RUNNING') {
    paneState.children.delete(member.conversationId)
    return null
  }
  const existing = paneState.children.get(member.conversationId)
  const previousWakeMode = existing?.lastMemberWakeMode
  const isWorking = member.wakeMode === 'working'
  if (existing && previousWakeMode !== 'working' && isWorking && existing.hookState === 'done') {
    existing.hookState = 'working'
  }
  let active = isWorking && existing?.hookState !== 'done'
  if (!isWorking) {
    if (previousWakeMode === 'working' && existing) {
      existing.hookState = undefined
      existing.toolName = undefined
      existing.toolInput = undefined
      active = false
    } else {
      active = Boolean(existing && existing.hookState && existing.hookState !== 'done')
    }
  }
  const rootBrainDir = paneState.rootBrainDir
  const startAt =
    existing?.startedAt ??
    (rootBrainDir
      ? readAntigravityChildStartedAt(rootBrainDir, member.conversationId)
      : undefined) ??
    now
  getOrCreateTrackedChild(paneState, member.conversationId, startAt).lastMemberWakeMode =
    member.wakeMode
  if (!active) {
    return null
  }
  const tail = rootBrainDir
    ? readAntigravityChildTranscriptTail(rootBrainDir, member.conversationId)
    : undefined
  return buildActiveChildSnapshot({
    paneState,
    childId: member.conversationId,
    description: member.name,
    agentType: 'Swarm Worker',
    memberModel: member.model,
    tail,
    now
  })
}

function isRegularSubagentTailSettled(
  existing: TrackedAntigravityChild | undefined,
  tail: AntigravityChildTranscriptTail | undefined
): boolean {
  if (!tail?.settled) {
    return false
  }
  if (!existing || existing.hookState === undefined) {
    return true
  }
  if (tail.stepIndex !== undefined && existing.settledStepAtTurnStart !== undefined) {
    return tail.stepIndex > existing.settledStepAtTurnStart
  }
  if (
    tail.stepIndex !== undefined &&
    existing.hookStepIdx !== undefined &&
    tail.stepIndex >= existing.hookStepIdx
  ) {
    return true
  }
  return existing.settledStepAtTurnStart === undefined && existing.hookStepIdx === undefined
}

function reconcileDiskSubagentSnapshot(
  paneState: AntigravityPaneChildState,
  diskEntry: AntigravityDiskSubagent | undefined,
  childId: string,
  now: number
): AgentSubagentSnapshot | null {
  if (diskEntry?.state === 'SUBAGENT_STATE_KILLED') {
    paneState.children.delete(childId)
    return null
  }
  const existing = paneState.children.get(childId)
  if (existing?.hookState === 'done') {
    return null
  }
  const rootBrainDir = paneState.rootBrainDir
  const tail = rootBrainDir ? readAntigravityChildTranscriptTail(rootBrainDir, childId) : undefined
  if (isRegularSubagentTailSettled(existing, tail)) {
    return null
  }
  if (!existing && !tail && paneState.leadState === 'done' && !paneState.hasSpawnedHelper) {
    return null
  }
  return buildActiveChildSnapshot({
    paneState,
    childId,
    description: diskEntry?.role || diskEntry?.typeName || 'Subagent',
    agentType: diskEntry?.typeName || 'subagent',
    tail,
    fallbackStart: tail?.createdAtMs,
    now
  })
}

export function reconcileAntigravityActiveSubagents(
  paneState: AntigravityPaneChildState,
  now: number
): AgentSubagentSnapshot[] {
  const rootBrainDir = paneState.rootBrainDir
  const diskSubagents = rootBrainDir
    ? readAntigravityBrainSubagents(rootBrainDir, paneState.brainCache)
    : []
  const swarmMeta = rootBrainDir
    ? readAntigravitySwarmMembers(rootBrainDir, paneState.brainCache)
    : undefined

  const diskSubagentById = new Map<string, AntigravityDiskSubagent>()
  for (const entry of diskSubagents) {
    diskSubagentById.set(entry.conversationId, entry)
  }

  const swarmById = new Map<string, AntigravityDiskSwarmMember>()
  for (const member of swarmMeta?.members ?? []) {
    if (member.role === 'coordinator' || member.conversationId === paneState.rootConversationId) {
      continue
    }
    swarmById.set(member.conversationId, member)
  }

  const snapshots: AgentSubagentSnapshot[] = []
  for (const member of swarmById.values()) {
    const snap = reconcileSwarmMemberSnapshot(paneState, member, now)
    if (snap) {
      snapshots.push(snap)
    }
  }

  const regularIds = new Set<string>()
  for (const id of diskSubagentById.keys()) {
    if (!swarmById.has(id) && id !== paneState.rootConversationId) {
      regularIds.add(id)
    }
  }
  for (const id of paneState.children.keys()) {
    if (!swarmById.has(id) && id !== paneState.rootConversationId) {
      regularIds.add(id)
    }
  }

  for (const childId of regularIds) {
    const snap = reconcileDiskSubagentSnapshot(
      paneState,
      diskSubagentById.get(childId),
      childId,
      now
    )
    if (snap) {
      snapshots.push(snap)
    }
  }

  snapshots.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  return snapshots
}
