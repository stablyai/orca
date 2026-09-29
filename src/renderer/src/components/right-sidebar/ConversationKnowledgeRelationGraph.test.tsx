import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConversationKnowledgeRelationGraph } from './ConversationKnowledgeRelationGraph'
import type { ConversationKnowledgeRelation } from '@/lib/conversation-knowledge-relations'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

describe('ConversationKnowledgeRelationGraph', () => {
  it('shows a directional relation and its separately attributed evidence', () => {
    const relation: ConversationKnowledgeRelation = {
      id: 'orca-summary-agent-claude',
      kind: 'claim',
      subject: 'Orca',
      relation: 'summary-agent',
      object: 'Claude',
      assertions: [
        {
          item: {
            id: 'one',
            source: {
              executionHostId: 'local',
              agent: 'codex',
              sessionId: 'session-1',
              title: 'Choice',
              cwd: '/orca',
              updatedAt: null
            },
            knowledge: { summary: '', topics: [], conclusions: [], entities: [] },
            generator: { agent: 'codex', model: 'test', generatedAt: '2026-09-18' }
          },
          entry: {
            kind: 'decision',
            text: 'Orca uses Claude.',
            reliability: 'user-confirmed',
            evidence: { kind: 'conversation', messageId: 'user-2' },
            lifecycle: { status: 'conflicted' }
          },
          score: 0
        }
      ]
    }
    const markup = renderToStaticMarkup(
      <ConversationKnowledgeRelationGraph relations={[relation]} onSelect={() => {}} />
    )
    expect(markup).toContain('Orca')
    expect(markup).toContain('summary-agent')
    expect(markup).toContain('Claude')
    expect(markup).toContain('Conflicted')
    expect(markup).toContain('session-1')
    expect(markup).toContain('user-2')
  })
})
