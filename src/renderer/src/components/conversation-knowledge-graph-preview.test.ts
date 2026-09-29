import { describe, expect, it } from 'vitest'
import type { ConversationKnowledgeGraph } from '../../../shared/conversation-knowledge-graph'
import {
  conversationKnowledgeGraphNodeWidth,
  focusConversationKnowledgeGraph,
  positionConversationKnowledgeGraphNodes,
  toggleFocusedNode
} from './conversation-knowledge-graph-preview'

const graph: ConversationKnowledgeGraph = {
  nodes: [
    { id: 'concept:git', type: 'concept', label: 'Git', itemCount: 2 },
    { id: 'concept:ui', type: 'concept', label: 'UI', itemCount: 1 },
    { id: 'digest:one', type: 'digest', label: 'One', itemCount: 1 },
    { id: 'digest:two', type: 'digest', label: 'Two', itemCount: 1 }
  ],
  edges: [
    { source: 'digest:one', target: 'concept:git', relation: 'about' },
    { source: 'digest:two', target: 'concept:git', relation: 'about' },
    { source: 'digest:two', target: 'concept:ui', relation: 'about' }
  ]
}

describe('focusConversationKnowledgeGraph', () => {
  it('keeps the complete graph before a node is selected', () => {
    expect(focusConversationKnowledgeGraph(graph, null)).toBe(graph)
  })

  it('shows every summary directly related to the selected node', () => {
    const focused = focusConversationKnowledgeGraph(graph, 'concept:git')
    expect(focused.nodes.map((node) => node.id)).toEqual([
      'concept:git',
      'digest:one',
      'digest:two'
    ])
  })

  it('restores the scoped graph when the focused summary is clicked again', () => {
    const focused = { id: 'digest:one', viewMode: 'project' as const, projectId: 'orca' }

    expect(toggleFocusedNode(focused, 'digest:one', 'project', 'orca')).toBeNull()
    expect(toggleFocusedNode(null, 'digest:one', 'project', 'orca')).toEqual(focused)
  })

  it('spreads knowledge summaries to the available right edge', () => {
    const narrow = positionConversationKnowledgeGraphNodes(graph, 630)
    const wide = positionConversationKnowledgeGraphNodes(graph, 900)
    const narrowKnowledge = narrow.find((node) => node.id === 'concept:git')
    const wideKnowledge = wide.find((node) => node.id === 'concept:git')

    expect(narrowKnowledge?.x).toBe(436)
    expect(wideKnowledge?.x).toBe(706)
    expect(wide.find((node) => node.id === 'digest:one')?.x).toBe(362)
  })

  it('uses narrower columns when a knowledge-note column is present', () => {
    const graphWithNote: ConversationKnowledgeGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: 'note:git-workflows',
          type: 'note',
          label: 'Safe Git workflows',
          itemCount: 1,
          knowledgeNote: {
            conceptId: 'concept:git',
            kind: 'method',
            applicability: 'Git repositories',
            status: 'supported',
            evidenceCount: 1
          }
        }
      ]
    }

    expect(conversationKnowledgeGraphNodeWidth(graphWithNote, 580)).toBe(128)
    expect(
      positionConversationKnowledgeGraphNodes(graphWithNote, 580).find(
        (node) => node.id === 'note:git-workflows'
      )?.x
    ).toBe(434)
  })

  it('stacks detailed nodes with their rendered height accounted for', () => {
    const graphWithStatements: ConversationKnowledgeGraph = {
      nodes: [
        {
          id: 'statement:one',
          type: 'statement',
          label: 'One',
          itemCount: 1,
          sourceBacked: { kind: 'decision', reliability: 'verified' }
        },
        {
          id: 'statement:two',
          type: 'statement',
          label: 'Two',
          itemCount: 1,
          sourceBacked: { kind: 'decision', reliability: 'verified' }
        }
      ],
      edges: []
    }

    const positions = positionConversationKnowledgeGraphNodes(graphWithStatements, 630)

    expect(positions.find((node) => node.id === 'statement:one')).toMatchObject({
      height: 80,
      y: 18
    })
    expect(positions.find((node) => node.id === 'statement:two')).toMatchObject({ y: 116 })
  })
})
