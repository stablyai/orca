import type { ConversationKnowledgeGraph } from '../../../shared/conversation-knowledge-graph'

const MAX_CONCEPTS = 18
const MAX_DIGESTS = 48

export function overviewConversationKnowledgeGraph(
  graph: ConversationKnowledgeGraph
): ConversationKnowledgeGraph {
  const concepts = graph.nodes
    .filter((node) => node.type === 'concept')
    .sort(
      (left, right) => right.itemCount - left.itemCount || left.label.localeCompare(right.label)
    )
    .slice(0, MAX_CONCEPTS)
  if (!concepts.length) {
    return graph
  }
  const conceptIds = new Set(concepts.map((node) => node.id))
  const digestIds = new Set(
    graph.edges.filter((edge) => conceptIds.has(edge.target)).map((edge) => edge.source)
  )
  const visibleDigests = graph.nodes
    .filter((node) => digestIds.has(node.id) && node.type === 'digest')
    .sort(
      (left, right) =>
        (right.item?.source.updatedAt ?? '').localeCompare(left.item?.source.updatedAt ?? '') ||
        left.label.localeCompare(right.label)
    )
    .slice(0, MAX_DIGESTS)
  const visibleDigestIds = new Set(visibleDigests.map((node) => node.id))
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const ids = new Set([...conceptIds, ...visibleDigestIds])
  for (const edge of graph.edges) {
    if (visibleDigestIds.has(edge.source) || visibleDigestIds.has(edge.target)) {
      const related = visibleDigestIds.has(edge.source) ? edge.target : edge.source
      const node = nodeById.get(related)
      if (node?.type === 'project' || node?.type === 'workspace' || node?.type === 'statement') {
        ids.add(related)
      }
    }
  }
  for (const edge of graph.edges) {
    if (conceptIds.has(edge.source) && edge.relation === 'organizes') {
      ids.add(edge.target)
    }
  }
  for (const edge of graph.edges) {
    if (ids.has(edge.target) && edge.relation === 'supports') {
      ids.add(edge.source)
    }
  }
  return {
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  }
}
