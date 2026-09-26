import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConversationKnowledgeDetail } from './ConversationKnowledgeDetail'
import type { ConversationKnowledgeItem } from '../../../../shared/conversation-knowledge-items'

vi.mock('react-i18next', () => ({ useTranslation: () => ({}) }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

describe('ConversationKnowledgeDetail', () => {
  it('shows source creation and latest modification times', () => {
    const markup = renderToStaticMarkup(
      <ConversationKnowledgeDetail item={knowledgeItem()} sourceHistoryScope="all" />
    )

    expect(markup).toContain('Created')
    expect(markup).toContain('Last modified')
    expect(markup).toContain('dateTime="2026-08-01T09:00:00.000Z"')
    expect(markup).toContain('dateTime="2026-09-02T11:00:00.000Z"')
  })

  it('shows handoff reliability and whether an entry is eligible for agent context', () => {
    const markup = renderToStaticMarkup(
      <ConversationKnowledgeDetail
        item={{
          ...knowledgeItem(),
          knowledge: {
            ...knowledgeItem().knowledge,
            handoff: [
              {
                kind: 'decision',
                text: 'Keep the execution host authoritative.',
                reliability: 'user-confirmed',
                evidence: {
                  kind: 'conversation',
                  messageId: 'user-1',
                  supportingMessageIds: ['user-0']
                }
              },
              {
                kind: 'decision',
                text: 'Move every transcript to a global store.',
                reliability: 'proposal',
                evidence: { kind: 'conversation', messageId: 'assistant-1' }
              }
            ]
          }
        }}
        sourceHistoryScope="all"
      />
    )

    expect(markup).toContain('Agent handoff')
    expect(markup).toContain('User confirmed')
    expect(markup).toContain('Included in agent context')
    expect(markup).toContain('Proposal')
    expect(markup).toContain('assistant-1')
    expect(markup).toContain('user-0')
  })

  it('shows inactive handoff lifecycle states as excluded from agent context', () => {
    const markup = renderToStaticMarkup(
      <ConversationKnowledgeDetail
        item={{
          ...knowledgeItem(),
          knowledge: {
            ...knowledgeItem().knowledge,
            handoff: [
              {
                kind: 'constraint',
                text: 'Retired constraint.',
                reliability: 'user-confirmed',
                evidence: { kind: 'conversation', messageId: 'user-1' },
                lifecycle: { status: 'superseded' }
              }
            ]
          }
        }}
        sourceHistoryScope="all"
      />
    )

    expect(markup).toContain('Superseded')
    expect(markup).toContain('Excluded from agent context')
  })
})

function knowledgeItem(): ConversationKnowledgeItem {
  return {
    id: 'local:codex:session-1',
    source: {
      executionHostId: 'local',
      agent: 'codex',
      sessionId: 'session-1',
      title: 'Session title',
      cwd: '/code/orca',
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: null,
      modifiedAt: '2026-09-02T11:00:00.000Z'
    },
    knowledge: {
      summary: 'Summary',
      topics: [],
      conclusions: [],
      entities: []
    },
    generator: {
      agent: 'codex',
      model: 'gpt-5',
      generatedAt: '2026-09-02T12:00:00.000Z'
    }
  }
}
