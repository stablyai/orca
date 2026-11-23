import { describe, expect, it } from 'vitest'
import type { ConversationKnowledgeItem } from '../../../shared/conversation-knowledge-items'
import { buildConversationKnowledgeRelations } from './conversation-knowledge-relations'

function item(
  id: string,
  agent: ConversationKnowledgeItem['source']['agent'],
  object: string,
  status?: 'conflicted'
): ConversationKnowledgeItem {
  return {
    id,
    source: {
      executionHostId: 'local',
      agent,
      sessionId: id,
      title: id,
      cwd: '/orca',
      updatedAt: null
    },
    knowledge: {
      summary: '',
      topics: [],
      conclusions: [],
      entities: [],
      handoff: [
        {
          kind: 'decision',
          text: `Orca uses ${object}.`,
          reliability: 'user-confirmed',
          evidence: { kind: 'conversation', messageId: `message-${id}` },
          lifecycle: status ? { status } : undefined,
          claim: {
            subject: 'Orca',
            relation: 'summary-agent',
            object,
            cardinality: 'single'
          }
        }
      ]
    },
    generator: { agent: 'codex', model: 'test', generatedAt: '2026-09-18' }
  }
}

describe('buildConversationKnowledgeRelations', () => {
  const items = [item('one', 'codex', 'Claude'), item('two', 'claude', 'claude')]

  it('links the same subject, relation, and object across agents without losing evidence', () => {
    const relations = buildConversationKnowledgeRelations(items, '')
    expect(relations).toHaveLength(1)
    expect(relations[0].assertions.map((assertion) => assertion.item.source.agent)).toEqual([
      'codex',
      'claude'
    ])
    expect(relations[0].assertions.map((assertion) => assertion.entry.evidence.messageId)).toEqual([
      'message-one',
      'message-two'
    ])
  })

  it('does not merge contradictory objects or erase their lifecycle', () => {
    const relations = buildConversationKnowledgeRelations(
      [...items, item('three', 'codex', 'Codex', 'conflicted')],
      ''
    )
    expect(relations).toHaveLength(2)
    expect(
      relations.find((relation) => relation.object === 'Codex')?.assertions[0].entry.lifecycle
    ).toEqual({ status: 'conflicted' })
  })

  it('limits links to matching claims within the supplied scope', () => {
    expect(buildConversationKnowledgeRelations(items.slice(0, 1), 'object:Claude')).toHaveLength(1)
    expect(buildConversationKnowledgeRelations(items.slice(0, 1), 'object:Codex')).toEqual([])
  })

  it('keeps source-backed statements that cannot safely form a triple', () => {
    const sourceBacked = item('statement', 'codex', 'Claude')
    sourceBacked.knowledge.handoff = [
      {
        kind: 'constraint',
        text: 'Preserve source evidence before promoting a candidate.',
        reliability: 'user-confirmed',
        evidence: { kind: 'conversation', messageId: 'message-statement' }
      }
    ]

    expect(buildConversationKnowledgeRelations([sourceBacked], '')).toEqual([
      expect.objectContaining({
        kind: 'statement',
        subject: 'statement',
        relation: 'records',
        object: 'Preserve source evidence before promoting a candidate.'
      })
    ])
  })
})
