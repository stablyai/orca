// The mutable state the journal fold accumulates: one entry per agent node, spawn
// order, edges, and the raw event list. Kept separate from the updaters so the
// fold's shape is one small, readable file.

import type { NativeChatSubagentEntry } from '../native-chat/native-chat-types'
import {
  AGENT_MAP_ROOT_ID,
  type AgentMapNode,
  type AgentMapNodeKind,
  type AgentMapRequest,
  type AgentMapTimelineEvent,
  type AgentMapTimelineEventKind,
  type AgentMapToolCall,
  type AgentMapTurn
} from './agent-session-map-model'

export type MutableNode = {
  id: string
  kind: AgentMapNodeKind
  label: string
  parentAgentId?: string
  firstTs: number
  lastTs: number
  toolCalls: Map<string, AgentMapToolCall>
  turns: Map<string, AgentMapTurn>
  requests: Map<string, AgentMapRequest>
  subagentEntries: Map<string, NativeChatSubagentEntry>
  promptCount: number
  filesTouched: string[]
  lastPromptText?: string
  lastPromptTs?: number
  lastStatusText?: string
  lastStatusTs?: number
}

export type MutableMap = {
  nodes: Map<string, MutableNode>
  spawnOrder: string[]
  /** Children that already raised a spawn event; the roster revises in place. */
  spawned: Set<string>
  events: AgentMapTimelineEvent[]
}

export function ensureNode(map: MutableMap, id: string, ts: number): MutableNode {
  const existing = map.nodes.get(id)
  if (existing) {
    return existing
  }
  const node: MutableNode = {
    id,
    kind: id === AGENT_MAP_ROOT_ID ? 'main' : 'subagent',
    label: id === AGENT_MAP_ROOT_ID ? 'Agent' : id.slice(0, 8),
    firstTs: ts,
    lastTs: ts,
    toolCalls: new Map(),
    turns: new Map(),
    requests: new Map(),
    subagentEntries: new Map(),
    promptCount: 0,
    filesTouched: []
  }
  map.nodes.set(id, node)
  map.spawnOrder.push(id)
  return node
}

export function touch(node: MutableNode, ts: number): void {
  node.firstTs = Math.min(node.firstTs, ts)
  node.lastTs = Math.max(node.lastTs, ts)
}

export function pushEvent(
  map: MutableMap,
  ts: number,
  seq: number,
  kind: AgentMapTimelineEventKind,
  nodeId: string,
  detail: string,
  failed?: boolean
): void {
  map.events.push({
    ts,
    seq,
    kind,
    nodeId,
    detail,
    ...(failed === undefined ? {} : { failed })
  })
}

/** Freeze a node for the AgentMap: sorted collections, the roster verdict, the label. */
export function finalizeNode(node: MutableNode): AgentMapNode {
  const entry = node.subagentEntries.get(node.id)
  if (entry && entry.label && entry.label !== node.label) {
    node.label = entry.label
  }
  const toolCalls = [...node.toolCalls.values()].sort((a, b) => a.startTs - b.startTs)
  const turns = [...node.turns.values()].sort(
    (a, b) => (a.startedAt ?? a.endedAt ?? 0) - (b.startedAt ?? b.endedAt ?? 0)
  )
  const requests = [...node.requests.values()].sort((a, b) => a.ts - b.ts)
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    ...(node.parentAgentId === undefined ? {} : { parentAgentId: node.parentAgentId }),
    firstTs: node.firstTs,
    lastTs: node.lastTs,
    toolCalls,
    turns,
    requests,
    promptCount: node.promptCount,
    filesTouched: node.filesTouched,
    ...(node.lastPromptText === undefined ? {} : { lastPromptText: node.lastPromptText }),
    ...(node.lastPromptTs === undefined ? {} : { lastPromptTs: node.lastPromptTs }),
    ...(entry === undefined
      ? {}
      : {
          subagentSettlement: {
            state: entry.state,
            ...(entry.settledAt === undefined ? {} : { settledAt: entry.settledAt })
          }
        }),
    ...(node.lastStatusText === undefined
      ? {}
      : {
          lastStatusText: node.lastStatusText,
          ...(node.lastStatusTs === undefined ? {} : { lastStatusTs: node.lastStatusTs })
        })
  }
}
