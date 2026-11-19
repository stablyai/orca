// Fold a session journal into an AgentMap. One forward pass over the rows in
// (sequence, sequenceIndex) order; joins are by id so a revision or a crash-recovered
// out-of-order row settles the same node. Unknown shapes are skipped, never thrown.

import { agentJournalItemSubagentId } from '../agent-session/journal/agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import { AGENT_MAP_ROOT_ID, type AgentMap, type AgentMapEdge } from './agent-session-map-model'
import {
  ensureNode,
  finalizeNode,
  pushEvent,
  touch,
  type MutableMap
} from './agent-session-map-fold-state'
import {
  recordDiff,
  recordSubagentEntries,
  recordUserPrompt,
  upsertRequest,
  upsertToolCall,
  upsertTurn
} from './agent-session-map-item-updaters'

function nodeOrderKey(item: AgentJournalRenderItem): [number, number] {
  return [item.sequence, item.sequenceIndex ?? 0]
}

function sortedItems(journal: readonly AgentJournalRenderItem[]): AgentJournalRenderItem[] {
  return [...journal].sort(
    (a, b) => nodeOrderKey(a)[0] - nodeOrderKey(b)[0] || nodeOrderKey(a)[1] - nodeOrderKey(b)[1]
  )
}

export function buildAgentSessionMap(journal: readonly AgentJournalRenderItem[]): AgentMap {
  const map: MutableMap = {
    nodes: new Map(),
    spawnOrder: [],
    spawned: new Set(),
    events: []
  }
  ensureNode(map, AGENT_MAP_ROOT_ID, 0)

  for (const item of sortedItems(journal)) {
    const nodeId = agentJournalItemSubagentId(item) ?? AGENT_MAP_ROOT_ID
    const node = ensureNode(map, nodeId, item.observedAt)
    touch(node, item.observedAt)
    if (node.parentAgentId === undefined && item.parentAgentId !== undefined) {
      node.parentAgentId = item.parentAgentId
    }

    switch (item.body.kind) {
      case 'message': {
        if (item.body.role === 'user') {
          node.promptCount += 1
          recordUserPrompt(node, item)
          pushEvent(map, item.observedAt, item.sequence, 'prompt', nodeId, 'prompt')
        }
        recordSubagentEntries(map, item, nodeId)
        break
      }
      case 'tool-call':
        upsertToolCall(map, node, item)
        break
      case 'turn':
        upsertTurn(map, node, item)
        break
      case 'question':
        upsertRequest(map, node, item, 'question')
        break
      case 'approval':
        upsertRequest(map, node, item, 'approval')
        break
      case 'status': {
        if (item.body.text !== undefined) {
          node.lastStatusText = item.body.text
        }
        break
      }
      case 'diff':
        recordDiff(node, item)
        break
      // Orca creation-fact cards (agent launches, handoffs, automation saves, tool adds,
      // wait ends, bot notes) carry no node or edge, so the map skips them.
      case 'agent-start':
      case 'agent-handoff':
      case 'automation-run-not-started':
      case 'automation-saved':
      case 'tool-added':
      case 'wait-ended':
      case 'bot-item-note':
        break
    }
  }

  const nodes = map.spawnOrder.flatMap((id) => {
    const node = map.nodes.get(id)
    return node === undefined ? [] : [finalizeNode(node)]
  })
  const timeline = [...map.events].sort((a, b) => a.ts - b.ts || a.seq - b.seq)
  return {
    rootId: AGENT_MAP_ROOT_ID,
    nodes,
    edges: deriveEdges(map),
    timeline
  }
}

/** One edge per non-root node, from its resolved spawner. A missing or self parent
 *  (an orphan row) falls back to the root so the tree always stays connected. */
function deriveEdges(map: MutableMap): AgentMapEdge[] {
  const edges: AgentMapEdge[] = []
  for (const id of map.spawnOrder) {
    if (id === AGENT_MAP_ROOT_ID) {
      continue
    }
    const node = map.nodes.get(id)
    if (node === undefined) {
      continue
    }
    const parent =
      node.parentAgentId !== undefined &&
      node.parentAgentId !== id &&
      map.nodes.has(node.parentAgentId)
        ? node.parentAgentId
        : AGENT_MAP_ROOT_ID
    edges.push({ from: parent, to: id, spawnedAt: node.firstTs })
  }
  return edges
}
