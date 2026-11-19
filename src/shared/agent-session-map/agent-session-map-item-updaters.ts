// One journal row's worth of the fold: upsert tool calls, turns, and requests into
// the mutable map. Rows are revised in place by the journal, so every upsert keeps
// the latest state and latches ends once.

import type {
  AgentJournalRenderItem,
  AgentJournalResolution
} from '../agent-session/journal/agent-session-journal-types'
import { isTextBlock } from '../native-chat/native-chat-types'
import { namedSubagents } from '../native-chat/transcript/subagents/native-chat-subagent-items'
import type {
  AgentMapRequest,
  AgentMapRequestKind,
  AgentMapToolCall,
  AgentMapTurn
} from './agent-session-map-model'
import {
  ensureNode,
  pushEvent,
  type MutableMap,
  type MutableNode
} from './agent-session-map-fold-state'
import { agentSessionMapToolSummary } from './agent-session-map-tool-summary'

function resolutionState(resolution: AgentJournalResolution): AgentMapRequest['resolution'] {
  if (resolution.state === 'pending') {
    return 'pending'
  }
  if (resolution.state === 'cancelled') {
    return 'cancelled'
  }
  return 'resolved'
}

/** A failed state, or a terminal the host could not confirm as success. */
function toolCallEndedUnsuccessfully(body: { state: string; endedAs?: string }): boolean {
  return (
    body.state === 'failed' || body.endedAs === 'interrupted' || body.endedAs === 'unverifiable'
  )
}

export function upsertToolCall(
  map: MutableMap,
  node: MutableNode,
  item: AgentJournalRenderItem
): void {
  const body = item.body
  if (body.kind !== 'tool-call') {
    return
  }
  const callId = body.callId ?? item.itemId
  const existing = node.toolCalls.get(callId)
  const summary = agentSessionMapToolSummary(body.name, body.input)
  if (!existing) {
    const call: AgentMapToolCall = {
      callId,
      name: body.name,
      summary,
      state: body.state,
      startTs: item.observedAt
    }
    if (body.state !== 'running') {
      call.endTs = item.observedAt
    }
    node.toolCalls.set(callId, call)
    pushEvent(
      map,
      item.observedAt,
      item.sequence,
      'tool-start',
      node.id,
      `${body.name}${summary ? ` · ${summary}` : ''}`
    )
    if (body.state !== 'running') {
      pushEvent(
        map,
        item.observedAt,
        item.sequence,
        'tool-end',
        node.id,
        `${body.name} ${body.state}`,
        toolCallEndedUnsuccessfully(body)
      )
    }
    return
  }
  // Revision: latest state wins; the end is latched once, never re-opened.
  if (existing.state !== body.state) {
    existing.state = body.state
  }
  if (body.state !== 'running' && existing.endTs === undefined) {
    existing.endTs = item.observedAt
    const durationMs = body.durationMs
    existing.durationMs =
      typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
        ? durationMs
        : Math.max(0, (existing.endTs ?? existing.startTs) - existing.startTs)
    pushEvent(
      map,
      item.observedAt,
      item.sequence,
      'tool-end',
      node.id,
      `${body.name} ${body.state}`,
      toolCallEndedUnsuccessfully(body)
    )
  }
}

export function upsertTurn(map: MutableMap, node: MutableNode, item: AgentJournalRenderItem): void {
  const body = item.body
  if (body.kind !== 'turn') {
    return
  }
  const existing = node.turns.get(body.turnId)
  const lifecycle = body
  if (!existing) {
    const turn: AgentMapTurn = {
      turnId: body.turnId,
      state: lifecycle.state,
      ...(lifecycle.startedAt === undefined ? {} : { startedAt: lifecycle.startedAt })
    }
    if (lifecycle.state !== 'running') {
      turn.endedAt = item.observedAt
      turn.durationMs = lifecycle.durationMs
    }
    node.turns.set(body.turnId, turn)
    if (lifecycle.state !== 'running') {
      pushEvent(
        map,
        item.observedAt,
        item.sequence,
        'turn-end',
        node.id,
        `turn ${lifecycle.state}`,
        lifecycle.state === 'unverifiable'
      )
    }
    return
  }
  if (existing.state !== lifecycle.state) {
    existing.state = lifecycle.state
  }
  if (lifecycle.state !== 'running' && existing.endedAt === undefined) {
    existing.endedAt = item.observedAt
    existing.durationMs = lifecycle.durationMs
    pushEvent(
      map,
      item.observedAt,
      item.sequence,
      'turn-end',
      node.id,
      `turn ${lifecycle.state}`,
      lifecycle.state === 'unverifiable'
    )
  }
}

export function upsertRequest(
  map: MutableMap,
  node: MutableNode,
  item: AgentJournalRenderItem,
  kind: AgentMapRequestKind
): void {
  const body = item.body
  if (body.kind !== kind) {
    return
  }
  const existing = node.requests.get(item.itemId)
  const resolution = resolutionState(body.resolution)
  const resolvedAt =
    body.resolution.resolvedAt !== null && body.resolution.resolvedAt !== undefined
      ? body.resolution.resolvedAt
      : undefined
  if (!existing) {
    const request: AgentMapRequest = {
      kind,
      ts: item.observedAt,
      resolution,
      ...(requestDetail(body) === undefined ? {} : { detail: requestDetail(body) })
    }
    if (resolution !== 'pending') {
      request.resolvedAt = resolvedAt ?? item.observedAt
    }
    node.requests.set(item.itemId, request)
    pushEvent(
      map,
      item.observedAt,
      item.sequence,
      kind,
      node.id,
      kind === 'question' ? 'question' : 'approval'
    )
    return
  }
  if (existing.resolution === 'pending' && resolution !== 'pending') {
    existing.resolution = resolution
    existing.resolvedAt = resolvedAt ?? item.observedAt
  }
}

function requestDetail(
  body: Extract<AgentJournalRenderItem['body'], { kind: 'question' | 'approval' }>
): string | undefined {
  const text = body.kind === 'question' ? body.question : body.title
  return text.trim() === '' ? undefined : text
}

/** A diff row marks a file the node touched; the path is recorded once, first-seen order. */
export function recordDiff(node: MutableNode, item: AgentJournalRenderItem): void {
  const body = item.body
  if (body.kind !== 'diff') {
    return
  }
  if (!node.filesTouched.includes(body.path)) {
    node.filesTouched.push(body.path)
  }
}

/** A user prompt's text is the node's lastPromptText; the newest row wins. */
export function recordUserPrompt(node: MutableNode, item: AgentJournalRenderItem): void {
  const body = item.body
  if (body.kind !== 'message' || body.role !== 'user') {
    return
  }
  for (const block of body.blocks) {
    if (isTextBlock(block) && block.text.trim() !== '') {
      node.lastPromptText = block.text
      node.lastPromptTs = item.observedAt
      return
    }
  }
}

/** Spawn roster rows name the child agents: label, the provider's verdict, one spawn event.
 *  The row's own node is the spawner, so the child's parent is set from it — nesting stays a tree. */
export function recordSubagentEntries(
  map: MutableMap,
  item: AgentJournalRenderItem,
  spawnerId: string
): void {
  const body = item.body
  if (body.kind !== 'message') {
    return
  }
  for (const block of body.blocks) {
    for (const entry of namedSubagents(block)) {
      const child = ensureNode(map, entry.id, item.observedAt)
      child.subagentEntries.set(entry.id, entry)
      if (child.parentAgentId === undefined && spawnerId !== entry.id) {
        child.parentAgentId = spawnerId
      }
      if (entry.label && entry.label !== child.label) {
        child.label = entry.label
      }
      if (!map.spawned.has(entry.id)) {
        map.spawned.add(entry.id)
        pushEvent(
          map,
          item.observedAt,
          item.sequence,
          'agent-spawn',
          entry.id,
          `spawn ${entry.label || entry.id.slice(0, 8)}`
        )
      }
    }
  }
}
