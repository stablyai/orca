import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConversationKnowledgeClaimResults } from './ConversationKnowledgeClaimResults'
import type { ConversationKnowledgeClaimMatch } from '@/lib/conversation-knowledge-claim-search'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

describe('ConversationKnowledgeClaimResults', () => {
  it('shows the matching relation, conflict status, and source message location', () => {
    const match: ConversationKnowledgeClaimMatch = {
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
        evidence: {
          kind: 'conversation',
          messageId: 'user-2',
          supportingMessageIds: ['user-1']
        },
        lifecycle: { status: 'conflicted' },
        claim: {
          subject: 'Orca',
          relation: 'summary-agent',
          object: 'Claude',
          cardinality: 'single'
        }
      },
      score: 12
    }
    const markup = renderToStaticMarkup(
      <ConversationKnowledgeClaimResults matches={[match]} onSelect={() => {}} />
    )
    expect(markup).toContain('Orca → summary-agent → Claude')
    expect(markup).toContain('Conflicted')
    expect(markup).toContain('session-1')
    expect(markup).toContain('user-2')
    expect(markup).toContain('user-1')
  })
})
