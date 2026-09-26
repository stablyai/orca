import { describe, expect, it } from 'vitest'
import {
  buildConversationKnowledgeContextPack,
  type ConversationKnowledgeItem
} from './conversation-knowledge-items'

const source = {
  executionHostId: 'local' as const,
  agent: 'codex' as const,
  sessionId: 'session-1',
  title: 'Implement session handoff',
  cwd: '/code/orca',
  updatedAt: '2026-09-15T10:00:00.000Z'
}

function item(
  overrides: Partial<ConversationKnowledgeItem['knowledge']> = {}
): ConversationKnowledgeItem {
  return {
    id: 'local:codex:session-1',
    source,
    knowledge: {
      summary: 'A session summary.',
      topics: [],
      conclusions: [],
      entities: [],
      handoff: [],
      ...overrides
    },
    generator: { agent: 'codex', model: 'gpt-5.6-sol', generatedAt: source.updatedAt }
  }
}

describe('conversation knowledge handoff', () => {
  it('only injects source-backed user decisions', () => {
    const context = buildConversationKnowledgeContextPack({
      items: [
        item({
          handoff: [
            {
              kind: 'decision',
              text: 'Keep SSH disconnects unverifiable.',
              reliability: 'user-confirmed',
              evidence: { kind: 'conversation', messageId: 'user-12' }
            },
            {
              kind: 'progress',
              text: 'The targeted test passed.',
              reliability: 'verified',
              evidence: { kind: 'tool-result', messageId: 'tool-4' }
            },
            {
              kind: 'constraint',
              text: 'Use a global graph database.',
              reliability: 'inferred',
              evidence: { kind: 'conversation', messageId: 'assistant-8' }
            },
            {
              kind: 'open-loop',
              text: 'Consider syncing every transcript.',
              reliability: 'proposal',
              evidence: { kind: 'conversation', messageId: 'assistant-9' }
            }
          ]
        })
      ],
      cwd: '/code/orca'
    })

    expect(context).toContain('Keep SSH disconnects unverifiable.')
    expect(context).not.toContain('The targeted test passed.')
    expect(context).not.toContain('global graph database')
    expect(context).not.toContain('syncing every transcript')
    expect(context).toContain('session-1')
  })

  it('does not manufacture context when no source-backed handoff exists', () => {
    expect(
      buildConversationKnowledgeContextPack({
        items: [
          item({
            handoff: [
              {
                kind: 'decision',
                text: 'This may be correct.',
                reliability: 'inferred',
                evidence: { kind: 'conversation', messageId: 'assistant-1' }
              }
            ]
          })
        ],
        cwd: '/code/orca'
      })
    ).toBe('')
  })

  it('excludes superseded and conflicted claims from agent context', () => {
    const context = buildConversationKnowledgeContextPack({
      items: [
        item({
          handoff: [
            {
              kind: 'constraint',
              text: 'Use the retired handoff policy.',
              reliability: 'user-confirmed',
              evidence: { kind: 'conversation', messageId: 'user-1' },
              lifecycle: { status: 'superseded' }
            },
            {
              kind: 'constraint',
              text: 'Use the disputed handoff policy.',
              reliability: 'user-confirmed',
              evidence: { kind: 'conversation', messageId: 'user-2' },
              lifecycle: { status: 'conflicted' }
            },
            {
              kind: 'constraint',
              text: 'Keep the active handoff policy.',
              reliability: 'user-confirmed',
              evidence: { kind: 'conversation', messageId: 'user-3' },
              lifecycle: { status: 'active' }
            }
          ]
        })
      ],
      cwd: '/code/orca'
    })

    expect(context).toContain('Keep the active handoff policy.')
    expect(context).not.toContain('retired handoff policy')
    expect(context).not.toContain('disputed handoff policy')
  })
})
