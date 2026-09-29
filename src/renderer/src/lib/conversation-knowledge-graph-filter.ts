import type {
  ConversationKnowledgeGraph,
  ConversationKnowledgeGraphNode
} from '../../../shared/conversation-knowledge-graph'
import {
  conversationKnowledgeSearchText,
  type ConversationKnowledgeItem
} from '../../../shared/conversation-knowledge-items'
import {
  hasStructuredClaimTerms,
  searchConversationKnowledgeClaims
} from './conversation-knowledge-claim-search'
import {
  hasSourceBackedFilters,
  matchesSourceBackedFilters,
  parseSourceBackedFilters
} from './conversation-knowledge-source-backed-filters'

export function withoutConversationKnowledgeNotes(
  graph: ConversationKnowledgeGraph
): ConversationKnowledgeGraph {
  const nodes = graph.nodes.filter((node) => node.type !== 'note')
  const nodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
  }
}

export function scopeConversationKnowledgeGraphToProject(
  graph: ConversationKnowledgeGraph,
  projectId: string | null
): ConversationKnowledgeGraph {
  const projectIds = new Set(
    graph.nodes.filter((node) => node.type === 'project').map((node) => node.id)
  )
  const requestedProject = projectId ? `project:${projectId}` : null
  const selectedProject =
    requestedProject && projectIds.has(requestedProject) ? requestedProject : null
  const projectDigestIds = new Set(
    graph.edges
      .filter(
        (edge) =>
          edge.relation === 'belongs-to' &&
          projectIds.has(edge.target) &&
          (!selectedProject || edge.target === selectedProject)
      )
      .map((edge) => edge.source)
  )
  const edges = graph.edges.filter(
    (edge) =>
      (!selectedProject && projectIds.has(edge.target)) ||
      (selectedProject && projectIds.has(edge.target) && projectDigestIds.has(edge.source)) ||
      projectDigestIds.has(edge.source) ||
      projectDigestIds.has(edge.target)
  )
  const ids = new Set(edges.flatMap((edge) => [edge.source, edge.target]))
  return { nodes: graph.nodes.filter((node) => ids.has(node.id)), edges }
}

export function searchConversationKnowledgeGraph(
  graph: ConversationKnowledgeGraph,
  query: string
): ConversationKnowledgeGraph {
  const { filters, tokens } = parseSourceBackedFilters(query)
  if (!tokens.length && !hasSourceBackedFilters(filters) && !hasStructuredClaimTerms(query)) {
    return graph
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const directScores = new Map<string, number>()
  const knowledgeScores = new Map<string, number>()
  const structuredClaimQuery = hasStructuredClaimTerms(query)
  for (const node of graph.nodes) {
    if (hasSourceBackedFilters(filters) && !matchesSourceBackedFilters(node, filters)) {
      continue
    }
    const claimScore = node.item
      ? (searchConversationKnowledgeClaims([node.item], query)[0]?.score ?? null)
      : null
    const contentScore = structuredClaimQuery || !tokens.length ? null : scoreNode(node, tokens)
    if (tokens.length && !structuredClaimQuery && contentScore === null && claimScore === null) {
      continue
    }
    const filterScore = hasSourceBackedFilters(filters) ? 1 : null
    const score = highestScore(claimScore, contentScore, filterScore)
    if (score === null) {
      continue
    }
    directScores.set(node.id, score)
    if (node.type === 'digest') {
      knowledgeScores.set(node.id, score)
    }
  }
  for (const edge of graph.edges) {
    addRelatedKnowledgeScore(edge.source, edge.target, nodeById, directScores, knowledgeScores)
    addRelatedKnowledgeScore(edge.target, edge.source, nodeById, directScores, knowledgeScores)
  }
  const edges = hasSourceBackedFilters(filters)
    ? graph.edges.filter((edge) => directScores.has(edge.source) || directScores.has(edge.target))
    : graph.edges.filter(
        (edge) => knowledgeScores.has(edge.source) || knowledgeScores.has(edge.target)
      )
  const ids = new Set(edges.flatMap((edge) => [edge.source, edge.target]))
  for (const id of knowledgeScores.keys()) {
    ids.add(id)
  }
  const originalOrder = new Map(graph.nodes.map((node, index) => [node.id, index]))
  const nodes = graph.nodes
    .filter((node) => ids.has(node.id))
    .map((node) => ({
      ...node,
      relevance:
        directScores.get(node.id) ??
        knowledgeScores.get(node.id) ??
        connectedKnowledgeScore(node.id, edges, knowledgeScores) * 0.25
    }))
    .sort(
      (left, right) =>
        (right.relevance ?? 0) - (left.relevance ?? 0) ||
        (originalOrder.get(left.id) ?? 0) - (originalOrder.get(right.id) ?? 0)
    )
  return { nodes, edges }
}

function highestScore(...scores: (number | null)[]): number | null {
  const values = scores.filter((score): score is number => score !== null)
  return values.length ? Math.max(...values) : null
}

export function conversationKnowledgeItemsInGraph(
  graph: ConversationKnowledgeGraph
): ConversationKnowledgeItem[] {
  return graph.nodes.flatMap((node) => (node.type === 'digest' && node.item ? [node.item] : []))
}

function addRelatedKnowledgeScore(
  matchedId: string,
  relatedId: string,
  nodeById: ReadonlyMap<string, ConversationKnowledgeGraphNode>,
  directScores: ReadonlyMap<string, number>,
  knowledgeScores: Map<string, number>
): void {
  const score = directScores.get(matchedId)
  if (score === undefined || nodeById.get(relatedId)?.type !== 'digest') {
    return
  }
  knowledgeScores.set(relatedId, Math.max(knowledgeScores.get(relatedId) ?? 0, score * 0.6))
}

function connectedKnowledgeScore(
  nodeId: string,
  edges: readonly { source: string; target: string }[],
  knowledgeScores: ReadonlyMap<string, number>
): number {
  let score = 0
  for (const edge of edges) {
    const relatedId =
      edge.source === nodeId ? edge.target : edge.target === nodeId ? edge.source : null
    if (relatedId) {
      score = Math.max(score, knowledgeScores.get(relatedId) ?? 0)
    }
  }
  return score
}

function scoreNode(node: ConversationKnowledgeGraphNode, tokens: readonly string[]): number | null {
  const fields = weightedSearchFields(node).map((field) => ({
    ...field,
    value: normalizeText(field.value)
  }))
  let total = 0
  for (const token of tokens) {
    let best = 0
    for (const field of fields) {
      best = Math.max(best, fuzzyMatchScore(field.value, token) * field.weight)
    }
    if (best === 0) {
      return null
    }
    total += best
  }
  return total / tokens.length
}

function weightedSearchFields(
  node: ConversationKnowledgeGraphNode
): { value: string; weight: number }[] {
  const item = node.item
  if (!item) {
    return [{ value: node.label, weight: 10 }]
  }
  return [
    { value: node.label, weight: 10 },
    { value: item.knowledge.title ?? '', weight: 10 },
    ...item.knowledge.topics.map((value) => ({ value, weight: 9 })),
    ...(item.knowledge.searchTerms ?? []).map((value) => ({ value, weight: 9 })),
    ...item.knowledge.entities.map((value) => ({ value, weight: 8 })),
    { value: item.source.title, weight: 8 },
    ...item.knowledge.conclusions.map((value) => ({ value, weight: 6 })),
    { value: item.knowledge.summary, weight: 4 },
    { value: conversationKnowledgeSearchText(item), weight: 2 },
    { value: item.source.sessionId, weight: 1 },
    { value: item.source.agent, weight: 1 },
    { value: item.source.cwd ?? '', weight: 1 }
  ]
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function fuzzyMatchScore(value: string, query: string): number {
  if (!value || !query) {
    return 0
  }
  if (value === query) {
    return 1
  }
  if (value.startsWith(query)) {
    return 0.95
  }
  if (value.includes(query)) {
    const words = value.split(/[^\p{L}\p{N}]+/u)
    return words.some((word) => word.startsWith(query)) ? 0.9 : 0.8
  }
  if (query.length < 2) {
    return 0
  }
  let queryIndex = 0
  let firstMatch = -1
  let lastMatch = -1
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === query[queryIndex]) {
      firstMatch = firstMatch === -1 ? index : firstMatch
      lastMatch = index
      queryIndex += 1
    }
    if (queryIndex === query.length) {
      const density = query.length / (lastMatch - firstMatch + 1)
      return density >= 0.55 ? 0.45 + density * 0.25 : 0
    }
  }
  return 0
}
