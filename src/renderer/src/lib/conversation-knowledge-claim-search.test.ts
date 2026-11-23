import { describe, expect, it } from 'vitest'
import type { ConversationKnowledgeItem } from '../../../shared/conversation-knowledge-items'
import { searchConversationKnowledgeClaims } from './conversation-knowledge-claim-search'

const items: ConversationKnowledgeItem[] = [
  {
    id: 'local:codex:one',
    source: {
      executionHostId: 'local',
      agent: 'codex',
      sessionId: 'one',
      title: 'Choices',
      cwd: '/orca',
      updatedAt: null
    },
    knowledge: {
      summary: 'Development choices',
      topics: [],
      conclusions: [],
      entities: [],
      handoff: [
        {
          kind: 'decision',
          text: 'Orca uses Codex for summaries.',
          reliability: 'user-confirmed',
          evidence: { kind: 'conversation', messageId: 'user-1' },
          claim: {
            subject: 'Orca',
            relation: 'summary-agent',
            object: 'Codex',
            cardinality: 'single'
          }
        },
        {
          kind: 'decision',
          text: 'Orca uses Claude for summaries.',
          reliability: 'user-confirmed',
          evidence: { kind: 'conversation', messageId: 'user-2' },
          lifecycle: { status: 'conflicted', reason: 'automatic-conflict' },
          claim: {
            subject: 'Orca',
            relation: 'summary-agent',
            object: 'Claude',
            cardinality: 'single'
          }
        }
      ]
    },
    generator: { agent: 'codex', model: 'gpt-5.6-sol', generatedAt: '2026-09-18T00:00:00Z' }
  }
]

describe('searchConversationKnowledgeClaims', () => {
  it('matches subject, relation, object, status and returns evidence location', () => {
    const results = searchConversationKnowledgeClaims(
      items,
      'relation:summary-agent object:Claude status:conflicted'
    )
    expect(results).toHaveLength(1)
    expect(results[0].entry.evidence.messageId).toBe('user-2')
    expect(results[0].item.source.sessionId).toBe('one')
  })

  it('does not return a whole summary when the requested claim value differs', () => {
    expect(searchConversationKnowledgeClaims(items, 'object:Gemini')).toEqual([])
  })

  it('searches claim words and limits results to the scoped items', () => {
    expect(
      searchConversationKnowledgeClaims(items, 'orca codex').map(
        (result) => result.entry.evidence.messageId
      )
    ).toEqual(['user-1'])
    expect(searchConversationKnowledgeClaims([], 'codex')).toEqual([])
  })
})
