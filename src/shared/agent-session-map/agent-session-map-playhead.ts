// The map as of one moment. `ts: null` is the live edge (the newest event); a number
// is the scrubber's playhead. Statuses are claimed only from dated events at or before
// the cursor — a node never shows a state its own rows have not yet reached.

import type {
  AgentMap,
  AgentMapNode,
  AgentMapNodeStatus,
  AgentMapNodeViewState,
  AgentMapViewState,
  AgentMapRequest,
  AgentMapTimelineEvent,
  AgentMapToolCall
} from './agent-session-map-model'

function liveEdgeTs(map: AgentMap): number {
  let ts = 0
  for (const node of map.nodes) {
    ts = Math.max(ts, node.lastTs)
  }
  for (const event of map.timeline) {
    ts = Math.max(ts, event.ts)
  }
  return ts
}

function toolStateAt(call: AgentMapToolCall, cursor: number): 'running' | 'completed' | 'failed' {
  if (call.endTs === undefined || call.endTs > cursor) {
    return 'running'
  }
  return call.state
}

function requestOpenAt(request: AgentMapRequest, cursor: number): boolean {
  if (request.ts > cursor) {
    return false
  }
  if (request.resolution === 'pending') {
    return true
  }
  return request.resolvedAt !== undefined && request.resolvedAt > cursor
}

function waitingOnAt(node: AgentMapNode, cursor: number): AgentMapNodeViewState['waitingOn'] {
  let waiting: AgentMapNodeViewState['waitingOn']
  for (const request of node.requests) {
    if (requestOpenAt(request, cursor)) {
      waiting = request.kind
    }
  }
  return waiting
}

function hasActivity(node: AgentMapNode): boolean {
  return (
    node.toolCalls.length > 0 ||
    node.turns.length > 0 ||
    node.requests.length > 0 ||
    node.promptCount > 0
  )
}

/** The node's last terminal event at or before the cursor, when it failed. */
function lastFailedTerminalAt(
  timeline: readonly AgentMapTimelineEvent[],
  nodeId: string,
  cursor: number
): boolean {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const event = timeline[i]
    if (event.nodeId !== nodeId) {
      continue
    }
    if (event.ts > cursor) {
      continue
    }
    if (event.kind === 'tool-end' || event.kind === 'turn-end') {
      return event.failed === true
    }
  }
  return false
}

/** The session moved on: another node has a dated event after this node's last row. */
function sessionMovedOn(timeline: readonly AgentMapTimelineEvent[], node: AgentMapNode): boolean {
  for (const event of timeline) {
    if (event.nodeId !== node.id && event.ts > node.lastTs) {
      return true
    }
  }
  return false
}

function nodeStatusAt(map: AgentMap, node: AgentMapNode, cursor: number): AgentMapNodeStatus {
  const activeTool = node.toolCalls.find(
    (call) => call.startTs <= cursor && toolStateAt(call, cursor) === 'running'
  )
  const activeTurn = node.turns.find(
    (turn) =>
      (turn.startedAt ?? turn.endedAt ?? 0) <= cursor &&
      (turn.endedAt === undefined || turn.endedAt > cursor)
  )
  if (activeTool !== undefined || activeTurn !== undefined) {
    return 'running'
  }
  if (waitingOnAt(node, cursor) !== undefined) {
    return 'waiting'
  }
  if (node.kind === 'subagent') {
    const settlement = node.subagentSettlement
    if (
      settlement !== undefined &&
      (settlement.settledAt === undefined || settlement.settledAt <= cursor)
    ) {
      if (settlement.state === 'completed' || settlement.state === 'stopped') {
        return 'done'
      }
      if (settlement.state === 'failed') {
        return 'failed'
      }
      if (settlement.state === 'unverifiable') {
        return 'unknown'
      }
    }
    if (lastFailedTerminalAt(map.timeline, node.id, cursor)) {
      return 'failed'
    }
    if (sessionMovedOn(map.timeline, node)) {
      return 'done'
    }
  }
  return hasActivity(node) ? 'idle' : 'unknown'
}

function promptCountAt(
  timeline: readonly AgentMapTimelineEvent[],
  nodeId: string,
  cursor: number
): number {
  let count = 0
  for (const event of timeline) {
    if (event.kind === 'prompt' && event.nodeId === nodeId && event.ts <= cursor) {
      count += 1
    }
  }
  return count
}

export function mapStateAt(map: AgentMap, ts: number | null): AgentMapViewState {
  const cursor = ts === null ? liveEdgeTs(map) : ts
  const nodes: AgentMapNodeViewState[] = []
  for (const node of map.nodes) {
    if (node.firstTs > cursor) {
      continue
    }
    const activeTool = node.toolCalls.find(
      (call) => call.startTs <= cursor && toolStateAt(call, cursor) === 'running'
    )
    const toolsAt = node.toolCalls.filter((call) => call.startTs <= cursor)
    let completedToolCount = 0
    let failedToolCount = 0
    for (const call of toolsAt) {
      const state = toolStateAt(call, cursor)
      if (state === 'completed') {
        completedToolCount += 1
      } else if (state === 'failed') {
        failedToolCount += 1
      }
    }
    const status = nodeStatusAt(map, node, cursor)
    const waitingOn = waitingOnAt(node, cursor)
    nodes.push({
      nodeId: node.id,
      status,
      ...(activeTool === undefined ? {} : { activeTool }),
      toolCount: toolsAt.length,
      completedToolCount,
      failedToolCount,
      promptCount: promptCountAt(map.timeline, node.id, cursor),
      ...(waitingOn === undefined ? {} : { waitingOn }),
      ...(node.lastStatusText === undefined ? {} : { lastStatusText: node.lastStatusText })
    })
  }
  const activeNodeIds = nodes
    .filter((node) => node.status === 'running' || node.status === 'waiting')
    .map((node) => node.nodeId)
  return { ts: cursor, nodes, activeNodeIds }
}
