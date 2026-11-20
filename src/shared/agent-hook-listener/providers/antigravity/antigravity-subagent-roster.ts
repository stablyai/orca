import type { AgentSubagentSnapshot } from '../../../agent-status/contracts/agent-status-subagent-snapshot'
import type {
  AntigravityChildTranscriptTail,
  AntigravityDiskSubagent,
  AntigravityDiskSwarmMember
} from './antigravity-brain-metadata'
import { isAntigravityFeedbackTool } from './antigravity-event-rules'
import {
  getOrCreateAntigravityPaneState,
  getOrCreateTrackedChild,
  recordAntigravityChildHook,
  retireAntigravityChild,
  type AntigravityPaneChildState,
  type TrackedAntigravityChild
} from './antigravity-pane-state'

export {
  getOrCreateAntigravityPaneState,
  recordAntigravityChildHook,
  retireAntigravityChild,
  type AntigravityPaneChildState
}

function resolveChildModel(
  tracked: TrackedAntigravityChild,
  memberModel: string | undefined,
  tail: AntigravityChildTranscriptTail | undefined
): string | undefined {
  if (memberModel !== undefined && memberModel !== tracked.lastMemberModel) {
    tracked.lastMemberModel = memberModel
    tracked.fallbackModel = memberModel
    if (tracked.hookModel && tracked.hookModel !== memberModel) {
      tracked.hookModel = undefined
    }
  }
  if (tracked.hookModel) {
    return tracked.hookModel
  }
  const liveMetadataModel = memberModel ?? tail?.model
  if (liveMetadataModel) {
    tracked.fallbackModel = liveMetadataModel
    return liveMetadataModel
  }
  if (tracked.fallbackModel) {
    return tracked.fallbackModel
  }
  return undefined
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
  const initialStart =
    paneState.children.get(childId)?.startedAt ?? tail?.createdAtMs ?? fallbackStart ?? now
  const tracked = getOrCreateTrackedChild(paneState, childId, initialStart)
  const toolName = tracked.sawToolHook ? tracked.toolName : (tracked.toolName ?? tail?.toolName)
  const toolInput = tracked.sawToolHook ? tracked.toolInput : (tracked.toolInput ?? tail?.toolInput)
  const waiting = tracked.hookState === 'waiting' || isAntigravityFeedbackTool(toolName)
  return {
    id: childId,
    description,
    agentType,
    model: resolveChildModel(tracked, memberModel, tail),
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
    retireAntigravityChild(paneState, member.conversationId)
    return null
  }
  const existing = paneState.children.get(member.conversationId)
  const wakeChanged = existing?.lastMemberWakeMode !== member.wakeMode
  if (wakeChanged && existing) {
    if (member.wakeMode === 'working') {
      paneState.retiredChildren.delete(member.conversationId)
      existing.hookState = 'working'
    } else if (member.wakeMode === 'mentions') {
      existing.hookState = undefined
      existing.toolName = undefined
      existing.toolInput = undefined
    }
  }
  const active =
    !paneState.retiredChildren.has(member.conversationId) &&
    (existing?.hookState !== undefined
      ? existing.hookState !== 'done'
      : member.wakeMode === 'working')

  const startAt =
    existing?.startedAt ?? paneState.transcriptTails.get(member.conversationId)?.createdAtMs ?? now
  getOrCreateTrackedChild(paneState, member.conversationId, startAt).lastMemberWakeMode =
    member.wakeMode
  if (!active) {
    return null
  }
  const tail = paneState.transcriptTails.get(member.conversationId)
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
  return false
}

function reconcileDiskSubagentSnapshot(
  paneState: AntigravityPaneChildState,
  diskEntry: AntigravityDiskSubagent | undefined,
  childId: string,
  now: number
): AgentSubagentSnapshot | null {
  if (diskEntry?.state === 'SUBAGENT_STATE_KILLED') {
    retireAntigravityChild(paneState, childId)
    return null
  }
  const existing = paneState.children.get(childId)
  if (existing?.hookState === 'done' || paneState.retiredChildren.has(childId)) {
    return null
  }
  const tail = paneState.transcriptTails.get(childId)
  if (isRegularSubagentTailSettled(existing, tail)) {
    retireAntigravityChild(paneState, childId)
    return null
  }
  if (
    !existing &&
    !tail &&
    paneState.leadState === 'done' &&
    !paneState.awaitingInitialHelperDiscovery
  ) {
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
  const diskSubagents = paneState.diskSubagents ?? []
  const swarmMeta = { members: paneState.swarmMembers ?? [] }

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

  if (
    paneState.awaitingInitialHelperDiscovery &&
    [...diskSubagentById.keys(), ...swarmById.keys(), ...paneState.children.keys()].some(
      (id) =>
        !paneState.retiredChildren.has(id) && !paneState.awaitingInitialHelperDiscovery?.has(id)
    )
  ) {
    paneState.awaitingInitialHelperDiscovery = undefined
  }

  snapshots.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  return snapshots
}
