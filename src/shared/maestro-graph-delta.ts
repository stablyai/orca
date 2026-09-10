import { AgentGraphViewSchema, type AgentGraphView } from './maestro-contract'
import { assertAgentGraphDeltaContinuity } from './maestro-projection-boundary'

/** Folds one delta onto its snapshot, dropping edges whose endpoints the delta removed. */
export function applyAgentGraphDelta(
  previous: AgentGraphView,
  delta: AgentGraphView
): AgentGraphView {
  assertAgentGraphDeltaContinuity(previous, delta)
  const nodes = new Map(previous.nodes.map((node) => [node.id, node]))
  const edges = new Map(previous.edges.map((edge) => [edge.id, edge]))
  for (const id of delta.removed_node_ids) {
    nodes.delete(id)
  }
  for (const id of delta.removed_edge_ids) {
    edges.delete(id)
  }
  for (const node of delta.nodes) {
    nodes.set(node.id, node)
  }
  for (const edge of delta.edges) {
    edges.set(edge.id, edge)
  }
  const nodeIds = new Set(nodes.keys())
  return AgentGraphViewSchema.parse({
    ...delta,
    kind: 'snapshot',
    nodes: [...nodes.values()],
    edges: [...edges.values()].filter(
      (edge) => nodeIds.has(edge.source_id) && nodeIds.has(edge.target_id)
    ),
    removed_node_ids: [],
    removed_edge_ids: [],
    from_cursor: null,
    reset_required: false
  })
}
