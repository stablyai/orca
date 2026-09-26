import type {
  ConversationKnowledgeHandoffEntry,
  ConversationKnowledgeItem
} from './conversation-knowledge-items'
import type { Repo } from './repo-types'
import type { Worktree } from './worktree/types'

export type ConversationKnowledgeGraphNode = {
  id: string
  type: 'project' | 'workspace' | 'digest' | 'concept' | 'candidate' | 'statement' | 'note'
  label: string
  itemCount: number
  relevance?: number
  item?: ConversationKnowledgeItem
  sourceBacked?: Pick<
    ConversationKnowledgeHandoffEntry,
    'kind' | 'reliability' | 'lifecycle' | 'knowledge' | 'concepts'
  >
  knowledgeNote?: {
    conceptId: string
    status: 'supported' | 'verified'
    kind: NonNullable<ConversationKnowledgeHandoffEntry['knowledge']>['kind']
    applicability: string
    evidenceCount: number
  }
}

export type ConversationKnowledgeGraphRelation =
  | 'belongs-to'
  | 'occurred-in'
  | 'about'
  | 'mentions'
  | 'contains'
  | 'records'
  | 'organizes'
  | 'supports'

export type ConversationKnowledgeGraphEdge = {
  source: string
  target: string
  relation: ConversationKnowledgeGraphRelation
}

export type ConversationKnowledgeGraph = {
  nodes: ConversationKnowledgeGraphNode[]
  edges: ConversationKnowledgeGraphEdge[]
}

export function buildConversationKnowledgeGraph({
  repos,
  items,
  worktrees
}: {
  repos: readonly Repo[]
  worktrees: readonly Worktree[]
  items: readonly ConversationKnowledgeItem[]
}): ConversationKnowledgeGraph {
  const nodes = new Map<string, ConversationKnowledgeGraphNode>()
  const edges = new Map<string, ConversationKnowledgeGraphEdge>()
  const countedNodeItems = new Set<string>()

  for (const item of items) {
    const digestId = `digest:${item.id}`
    nodes.set(digestId, {
      id: digestId,
      type: 'digest',
      label: item.knowledge.title ?? item.source.title,
      itemCount: 1,
      item
    })
    for (const topic of item.knowledge.topics) {
      connectConceptNode(nodes, edges, countedNodeItems, topic, digestId, 'about')
    }
    for (const entity of item.knowledge.entities) {
      connectConceptNode(nodes, edges, countedNodeItems, entity, digestId, 'mentions')
    }
    connectCandidateNodes(nodes, edges, item, digestId)
    connectSourceBackedStatementNodes(nodes, edges, item, digestId)

    const worktree = longestPathMatch(item.source.cwd, worktrees)
    const repo = worktree
      ? repos.find((candidate) => candidate.id === worktree.repoId)
      : longestPathMatch(item.source.cwd, repos)
    if (repo) {
      const projectId = `project:${repo.id}`
      incrementNode(nodes, projectId, 'project', repo.displayName)
      addEdge(edges, digestId, projectId, 'belongs-to')
    }
    if (worktree) {
      const workspaceId = `workspace:${worktree.id}`
      incrementNode(nodes, workspaceId, 'workspace', worktree.branch.replace(/^refs\/heads\//, ''))
      addEdge(edges, digestId, workspaceId, 'occurred-in')
    }
  }
  connectKnowledgeNotes(nodes, edges)
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

function connectKnowledgeNotes(
  nodes: Map<string, ConversationKnowledgeGraphNode>,
  edges: Map<string, ConversationKnowledgeGraphEdge>
): void {
  for (const concept of [...nodes.values()].filter((node) => node.type === 'concept')) {
    const digestIds = new Set(
      [...edges.values()]
        .filter(
          (edge) =>
            edge.target === concept.id &&
            (edge.relation === 'about' || edge.relation === 'mentions')
        )
        .map((edge) => edge.source)
    )

    const evidence = [...edges.values()]
      .filter((edge) => digestIds.has(edge.source) && edge.relation === 'records')
      .map((edge) => nodes.get(edge.target))
      .filter(
        (node): node is ConversationKnowledgeGraphNode =>
          node?.type === 'statement' &&
          node.sourceBacked?.knowledge !== undefined &&
          isActiveSourceBackedKnowledge(node) &&
          statementTargetsConcept(node, concept)
      )
    const knowledge = evidence[0]?.sourceBacked?.knowledge
    if (!knowledge) {
      continue
    }
    const noteId = `note:${concept.id}`
    nodes.set(noteId, {
      id: noteId,
      type: 'note',
      label: concept.label,
      itemCount: evidence.length,
      knowledgeNote: {
        conceptId: concept.id,
        status: evidence.some((node) => node.sourceBacked?.reliability === 'verified')
          ? 'verified'
          : 'supported',
        kind: knowledge.kind,
        applicability: knowledge.applicability,
        evidenceCount: evidence.length
      }
    })
    addEdge(edges, concept.id, noteId, 'organizes')
    for (const statement of evidence) {
      addEdge(edges, statement.id, noteId, 'supports')
    }
  }
}

function statementTargetsConcept(
  statement: ConversationKnowledgeGraphNode,
  concept: ConversationKnowledgeGraphNode
): boolean {
  const explicitConcepts = statement.sourceBacked?.concepts
  if (!explicitConcepts?.length) {
    return true
  }
  return explicitConcepts.some(
    (label) => `concept:${normalizeKnowledgeLabel(label).toLocaleLowerCase()}` === concept.id
  )
}

function isActiveSourceBackedKnowledge(node: ConversationKnowledgeGraphNode): boolean {
  const lifecycle = node.sourceBacked?.lifecycle?.status
  return lifecycle === undefined || lifecycle === 'active'
}

function connectConceptNode(
  nodes: Map<string, ConversationKnowledgeGraphNode>,
  edges: Map<string, ConversationKnowledgeGraphEdge>,
  countedNodeItems: Set<string>,
  label: string,
  digestId: string,
  relation: 'about' | 'mentions'
): void {
  const normalized = normalizeKnowledgeLabel(label)
  if (!normalized) {
    return
  }
  const id = `concept:${normalized.toLocaleLowerCase()}`
  const countKey = `${id}\0${digestId}`
  if (!countedNodeItems.has(countKey)) {
    incrementNode(nodes, id, 'concept', normalized)
    countedNodeItems.add(countKey)
  }
  addEdge(edges, digestId, id, relation)
}

function connectCandidateNodes(
  nodes: Map<string, ConversationKnowledgeGraphNode>,
  edges: Map<string, ConversationKnowledgeGraphEdge>,
  item: ConversationKnowledgeItem,
  digestId: string
): void {
  const seen = new Set<string>()
  for (const [index, conclusion] of item.knowledge.conclusions.entries()) {
    const label = normalizeKnowledgeLabel(conclusion)
    const normalized = label.toLocaleLowerCase()
    if (!label || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    const candidateId = `candidate:${item.id}:${index}`
    nodes.set(candidateId, { id: candidateId, type: 'candidate', label, itemCount: 1, item })
    addEdge(edges, digestId, candidateId, 'contains')
  }
}

function connectSourceBackedStatementNodes(
  nodes: Map<string, ConversationKnowledgeGraphNode>,
  edges: Map<string, ConversationKnowledgeGraphEdge>,
  item: ConversationKnowledgeItem,
  digestId: string
): void {
  for (const [index, entry] of (item.knowledge.handoff ?? []).entries()) {
    const label = normalizeKnowledgeLabel(entry.text)
    if (!label) {
      continue
    }
    const statementId = `statement:${item.id}:${index}`
    nodes.set(statementId, {
      id: statementId,
      type: 'statement',
      label,
      itemCount: 1,
      item,
      sourceBacked: {
        kind: entry.kind,
        reliability: entry.reliability,
        lifecycle: entry.lifecycle,
        concepts: entry.concepts,
        knowledge: entry.knowledge
      }
    })
    addEdge(edges, digestId, statementId, 'records')
  }
}

function normalizeKnowledgeLabel(label: string): string {
  return label.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function incrementNode(
  nodes: Map<string, ConversationKnowledgeGraphNode>,
  id: string,
  type: ConversationKnowledgeGraphNode['type'],
  label: string
): void {
  const existing = nodes.get(id)
  if (existing) {
    existing.itemCount += 1
  } else {
    nodes.set(id, { id, type, label, itemCount: 1 })
  }
}

function addEdge(
  edges: Map<string, ConversationKnowledgeGraphEdge>,
  source: string,
  target: string,
  relation: ConversationKnowledgeGraphRelation
): void {
  if (relation === 'mentions' && edges.has(`${source}\0about\0${target}`)) {
    return
  }
  if (relation === 'about') {
    edges.delete(`${source}\0mentions\0${target}`)
  }
  edges.set(`${source}\0${relation}\0${target}`, { source, target, relation })
}

function longestPathMatch<T extends { path: string }>(
  pathValue: string | null,
  values: readonly T[]
): T | null {
  if (!pathValue) {
    return null
  }
  const normalizedPath = normalizePath(pathValue)
  return (
    values
      .filter((value) => {
        const candidatePath = normalizePath(value.path)
        return normalizedPath === candidatePath || normalizedPath.startsWith(`${candidatePath}/`)
      })
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null
  )
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLocaleLowerCase() : normalized
}
