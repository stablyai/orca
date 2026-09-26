import { describe, expect, it } from 'vitest'
import type { ConversationKnowledgeGraph } from '../../../shared/conversation-knowledge-graph'
import type { ConversationKnowledgeItem } from '../../../shared/conversation-knowledge-items'
import {
  conversationKnowledgeItemsInGraph,
  scopeConversationKnowledgeGraphToProject,
  searchConversationKnowledgeGraph
} from './conversation-knowledge-graph-filter'
import { overviewConversationKnowledgeGraph } from './conversation-knowledge-graph-overview'

const item = (
  id: string,
  title: string,
  summary: string,
  searchTerms: string[] = []
): ConversationKnowledgeItem => ({
  id,
  source: {
    executionHostId: 'local',
    agent: 'codex',
    sessionId: id,
    title,
    cwd: '/repo',
    updatedAt: '2026-09-08T00:00:00.000Z'
  },
  knowledge: { title, summary, conclusions: [], topics: [], entities: [], searchTerms },
  generator: { agent: 'codex', model: 'model', generatedAt: '2026-09-08T00:00:00.000Z' }
})

const graph: ConversationKnowledgeGraph = {
  nodes: [
    { id: 'project:one', type: 'project', label: 'Orca', itemCount: 1 },
    { id: 'project:two', type: 'project', label: 'Website', itemCount: 1 },
    { id: 'concept:git', type: 'concept', label: 'Git workflows', itemCount: 2 },
    {
      id: 'digest:one',
      type: 'digest',
      label: 'Rebase changes',
      itemCount: 1,
      item: item('one', 'Rebase changes', 'Updated the branch', [
        'git history cleanup',
        'rewrite history safely'
      ])
    },
    {
      id: 'digest:two',
      type: 'digest',
      label: 'Release notes',
      itemCount: 1,
      item: item('two', 'Release notes', 'Published the website')
    }
  ],
  edges: [
    { source: 'digest:one', target: 'project:one', relation: 'belongs-to' },
    { source: 'digest:two', target: 'project:two', relation: 'belongs-to' },
    { source: 'digest:one', target: 'concept:git', relation: 'about' },
    { source: 'digest:two', target: 'concept:git', relation: 'about' }
  ]
}

describe('conversation knowledge graph filters', () => {
  it('counts only summaries in the selected project scope', () => {
    const scoped = scopeConversationKnowledgeGraphToProject(graph, 'one')
    expect(conversationKnowledgeItemsInGraph(scoped).map((entry) => entry.id)).toEqual(['one'])
  })

  it('fuzzy-searches summary content and keeps its related nodes', () => {
    const result = searchConversationKnowledgeGraph(graph, 'upd brnch')
    expect(conversationKnowledgeItemsInGraph(result).map((entry) => entry.id)).toEqual(['one'])
    expect(result.nodes.map((node) => node.id)).toEqual([
      'digest:one',
      'project:one',
      'concept:git'
    ])
  })

  it('searches a relation node and returns every connected summary', () => {
    const result = searchConversationKnowledgeGraph(graph, 'git')
    expect(conversationKnowledgeItemsInGraph(result).map((entry) => entry.id)).toEqual([
      'one',
      'two'
    ])
  })

  it('searches generated semantic aliases and ranks direct matches first', () => {
    const reversedGraph = { ...graph, nodes: graph.nodes.toReversed() }
    const semanticResult = searchConversationKnowledgeGraph(reversedGraph, 'rewrite history')
    expect(conversationKnowledgeItemsInGraph(semanticResult).map((entry) => entry.id)).toEqual([
      'one'
    ])

    const rankedResult = searchConversationKnowledgeGraph(reversedGraph, 'git')
    expect(conversationKnowledgeItemsInGraph(rankedResult).map((entry) => entry.id)).toEqual([
      'one',
      'two'
    ])
  })

  it('shows only the summary carrying a matching structured claim', () => {
    const claimed = item('claimed', 'Choices', 'Agent choices')
    claimed.knowledge.handoff = [
      {
        kind: 'decision',
        text: 'Orca uses Codex.',
        reliability: 'user-confirmed',
        evidence: { kind: 'conversation', messageId: 'user-1' },
        claim: {
          subject: 'Orca',
          relation: 'summary-agent',
          object: 'Codex',
          cardinality: 'single'
        }
      }
    ]
    const result = searchConversationKnowledgeGraph(
      {
        nodes: [
          {
            id: 'digest:claimed',
            type: 'digest',
            label: 'Choices',
            itemCount: 1,
            item: claimed
          },
          {
            id: 'digest:other',
            type: 'digest',
            label: 'Codex',
            itemCount: 1,
            item: item('other', 'Codex', 'Unrelated')
          }
        ],
        edges: []
      },
      'relation:summary-agent object:Codex'
    )
    expect(conversationKnowledgeItemsInGraph(result).map((entry) => entry.id)).toEqual(['claimed'])
  })

  it('keeps the overview bounded while retaining its context and evidence', () => {
    const nodes: ConversationKnowledgeGraph['nodes'] = []
    const edges: ConversationKnowledgeGraph['edges'] = []
    for (let index = 0; index < 24; index += 1) {
      const conceptId = `concept:${index}`
      const digestId = `digest:${index}`
      nodes.push({
        id: conceptId,
        type: 'concept',
        label: `Concept ${index}`,
        itemCount: 24 - index
      })
      nodes.push({ id: digestId, type: 'digest', label: `Digest ${index}`, itemCount: 1 })
      edges.push({ source: digestId, target: conceptId, relation: 'about' })
    }

    const overview = overviewConversationKnowledgeGraph({ nodes, edges })

    expect(overview.nodes.filter((node) => node.type === 'concept')).toHaveLength(18)
    expect(overview.nodes.filter((node) => node.type === 'digest')).toHaveLength(18)
    expect(overview.edges).toHaveLength(18)
  })

  it('filters source-backed statements by reliability, kind, and lifecycle', () => {
    const sourceItem = item('source', 'Source-backed work', 'Summary')
    const graphWithStatements: ConversationKnowledgeGraph = {
      nodes: [
        {
          id: 'digest:source',
          type: 'digest',
          label: 'Source-backed work',
          itemCount: 1,
          item: sourceItem
        },
        {
          id: 'statement:confirmed',
          type: 'statement',
          label: 'Keep the durable checkpoint.',
          itemCount: 1,
          item: sourceItem,
          sourceBacked: { kind: 'decision', reliability: 'user-confirmed' }
        },
        {
          id: 'statement:proposal',
          type: 'statement',
          label: 'Consider a periodic checkpoint.',
          itemCount: 1,
          item: sourceItem,
          sourceBacked: {
            kind: 'open-loop',
            reliability: 'proposal',
            lifecycle: { status: 'superseded' }
          }
        }
      ],
      edges: [
        { source: 'digest:source', target: 'statement:confirmed', relation: 'records' },
        { source: 'digest:source', target: 'statement:proposal', relation: 'records' }
      ]
    }

    const reliable = searchConversationKnowledgeGraph(
      graphWithStatements,
      'reliability:user-confirmed kind:decision lifecycle:active'
    )

    expect(reliable.nodes.map((node) => node.id)).toEqual(['statement:confirmed', 'digest:source'])
    expect(conversationKnowledgeItemsInGraph(reliable).map((entry) => entry.id)).toEqual(['source'])
  })
})
