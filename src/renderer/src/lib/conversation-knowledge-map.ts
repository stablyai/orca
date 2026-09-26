import type {
  ConversationKnowledgeGraph,
  ConversationKnowledgeGraphNode
} from '../../../shared/conversation-knowledge-graph'

export type ConversationKnowledgeMapConcept = {
  concept: ConversationKnowledgeGraphNode
  evidenceCount: number
  hasKnowledgeNote: boolean
  verifiedEvidenceCount: number
}

export type ConversationKnowledgeMapCluster = {
  concepts: ConversationKnowledgeMapConcept[]
  id: string
  links: ConversationKnowledgeMapLink[]
}

export type ConversationKnowledgeMapLink = {
  evidenceCount: number
  source: string
  target: string
}

export function buildConversationKnowledgeMap(
  graph: ConversationKnowledgeGraph
): ConversationKnowledgeMapCluster[] {
  const concepts = graph.nodes.filter((node) => node.type === 'concept')
  const conceptIds = new Set(concepts.map((node) => node.id))
  const conceptIdByLabel = new Map(
    concepts.map((concept) => [normalizeConceptLabel(concept.label), concept.id])
  )
  const relatedConceptIds = new Map<string, string[]>()
  const statementIdsByConcept = new Map<string, Set<string>>()
  const noteIds = new Set(
    graph.edges
      .filter((edge) => edge.relation === 'organizes' && conceptIds.has(edge.source))
      .map((edge) => edge.source)
  )
  const statementIdsByDigest = new Map<string, string[]>()

  for (const edge of graph.edges) {
    if (edge.relation === 'records') {
      const ids = statementIdsByDigest.get(edge.source) ?? []
      ids.push(edge.target)
      statementIdsByDigest.set(edge.source, ids)
    }
  }

  const statementById = new Map(graph.nodes.map((node) => [node.id, node]))
  for (const statementIds of statementIdsByDigest.values()) {
    for (const statementId of statementIds) {
      const statement = statementById.get(statementId)
      const ids =
        statement?.type === 'statement'
          ? statementConceptIds(statement, conceptIdByLabel, concepts)
          : []
      const uniqueIds = [...new Set(ids)]
      if (!uniqueIds.length) {
        continue
      }
      relatedConceptIds.set(statementId, uniqueIds)
      for (const conceptId of uniqueIds) {
        const conceptStatements = statementIdsByConcept.get(conceptId) ?? new Set<string>()
        conceptStatements.add(statementId)
        statementIdsByConcept.set(conceptId, conceptStatements)
      }
    }
  }

  const mapConcepts = concepts.map((concept) => {
    const statementIds = statementIdsByConcept.get(concept.id) ?? new Set<string>()
    const statements = [...statementIds]
      .map((id) => statementById.get(id))
      .filter((node): node is ConversationKnowledgeGraphNode => node?.type === 'statement')
    return {
      concept,
      evidenceCount: statements.length,
      hasKnowledgeNote: noteIds.has(concept.id),
      verifiedEvidenceCount: statements.filter(
        (statement) => statement.sourceBacked?.reliability === 'verified'
      ).length
    }
  })
  return clusterMapConcepts(
    mapConcepts.filter((concept) => concept.evidenceCount > 0),
    countConceptLinks(relatedConceptIds)
  )
}

function normalizeConceptLabel(label: string): string {
  return label.normalize('NFKC').trim().toLocaleLowerCase()
}

function statementConceptIds(
  statement: ConversationKnowledgeGraphNode,
  conceptIdByLabel: ReadonlyMap<string, string>,
  concepts: readonly ConversationKnowledgeGraphNode[]
): string[] {
  const explicitIds = (statement.sourceBacked?.concepts ?? [])
    .map(normalizeConceptLabel)
    .map((label) => conceptIdByLabel.get(label))
    .filter((conceptId): conceptId is string => conceptId !== undefined)
  if (explicitIds.length) {
    return explicitIds
  }
  const statementText = normalizeConceptLabel(statement.label)
  return concepts
    .filter((concept) => {
      const label = normalizeConceptLabel(concept.label)
      return label.length >= 3 && statementText.includes(label)
    })
    .map((concept) => concept.id)
}

function clusterMapConcepts(
  concepts: ConversationKnowledgeMapConcept[],
  links: readonly ConversationKnowledgeMapLink[]
): ConversationKnowledgeMapCluster[] {
  const parent = new Map(concepts.map(({ concept }) => [concept.id, concept.id]))
  for (const link of links) {
    union(parent, link.source, link.target)
  }
  const grouped = new Map<string, ConversationKnowledgeMapConcept[]>()
  for (const concept of concepts) {
    const root = find(parent, concept.concept.id)
    const group = grouped.get(root) ?? []
    group.push(concept)
    grouped.set(root, group)
  }
  return [...grouped.entries()]
    .map(([id, group]) => {
      const conceptIds = new Set(group.map((entry) => entry.concept.id))
      return {
        concepts: group.sort(
          (left, right) =>
            right.evidenceCount - left.evidenceCount ||
            right.concept.itemCount - left.concept.itemCount ||
            left.concept.label.localeCompare(right.concept.label)
        ),
        id,
        links: links.filter((link) => conceptIds.has(link.source) && conceptIds.has(link.target))
      }
    })
    .sort(
      (left, right) =>
        right.concepts.reduce((count, entry) => count + entry.evidenceCount, 0) -
          left.concepts.reduce((count, entry) => count + entry.evidenceCount, 0) ||
        left.concepts[0]!.concept.label.localeCompare(right.concepts[0]!.concept.label)
    )
}

function countConceptLinks(
  statementConceptIds: ReadonlyMap<string, readonly string[]>
): ConversationKnowledgeMapLink[] {
  const counts = new Map<string, number>()
  for (const ids of statementConceptIds.values()) {
    for (let index = 0; index < ids.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < ids.length; otherIndex += 1) {
        const [source, target] = [ids[index], ids[otherIndex]].sort()
        const key = `${source}\0${target}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()].map(([key, evidenceCount]) => {
    const [source, target] = key.split('\0')
    return { source, target, evidenceCount }
  })
}

function find(parent: ReadonlyMap<string, string>, id: string): string {
  let current = id
  while (parent.get(current) !== current) {
    current = parent.get(current) ?? current
  }
  return current
}

function union(parent: Map<string, string>, left: string, right: string): void {
  const leftRoot = find(parent, left)
  const rightRoot = find(parent, right)
  if (leftRoot !== rightRoot) {
    parent.set(rightRoot, leftRoot)
  }
}
