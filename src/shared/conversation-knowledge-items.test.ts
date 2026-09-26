import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_KNOWLEDGE_FORMAT_VERSION,
  CONVERSATION_KNOWLEDGE_GENERATION_PROMPT_PREFIX,
  isConversationKnowledgeGenerationTitle,
  isConversationKnowledgeItemFresh,
  searchConversationKnowledgeItems,
  type ConversationKnowledgeItem
} from './conversation-knowledge-items'

const baseItem: ConversationKnowledgeItem = {
  id: 'local:codex:session-1',
  source: {
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'session-1',
    title: 'Fix SSH lifecycle handling',
    cwd: '/code/orca',
    updatedAt: '2026-09-01T10:00:00.000Z'
  },
  knowledge: {
    summary: 'Loss of contact must not be treated as process exit.',
    topics: ['SSH', 'process lifecycle'],
    conclusions: ['Use live, unverifiable, and exited verdicts.'],
    entities: ['Orca'],
    searchTerms: ['remote reconnection safeguards']
  },
  generator: {
    agent: 'codex',
    model: 'gpt-5',
    generatedAt: '2026-09-01T10:01:00.000Z',
    formatVersion: CONVERSATION_KNOWLEDGE_FORMAT_VERSION
  }
}

describe('conversation knowledge items', () => {
  it('identifies system-derived sessions independently of the generator model', () => {
    expect(
      isConversationKnowledgeGenerationTitle(
        `${CONVERSATION_KNOWLEDGE_GENERATION_PROMPT_PREFIX} v1`
      )
    ).toBe(true)
    expect(
      isConversationKnowledgeGenerationTitle(
        'Below is a conversation log from a Claude Code coding session. Create a summary.'
      )
    ).toBe(true)
  })

  it('searches generated knowledge instead of raw transcript text', () => {
    expect(searchConversationKnowledgeItems([baseItem], 'unverifiable')).toEqual([baseItem])
    expect(searchConversationKnowledgeItems([baseItem], 'reconnection safeguards')).toEqual([
      baseItem
    ])
    expect(searchConversationKnowledgeItems([baseItem], 'unrelated raw prompt')).toEqual([])
  })

  it('invalidates an item when the source session or generator changes', () => {
    expect(
      isConversationKnowledgeItemFresh(baseItem, {
        sourceUpdatedAt: baseItem.source.updatedAt,
        generatorAgent: 'codex',
        generatorModel: 'gpt-5'
      })
    ).toBe(true)
    expect(
      isConversationKnowledgeItemFresh(baseItem, {
        sourceUpdatedAt: '2026-09-02T10:00:00.000Z',
        generatorAgent: 'codex',
        generatorModel: 'gpt-5'
      })
    ).toBe(false)
  })

  it('invalidates legacy items when the enrichment format changes', () => {
    const legacy = {
      ...baseItem,
      generator: { ...baseItem.generator, formatVersion: undefined }
    }
    expect(
      isConversationKnowledgeItemFresh(legacy, {
        sourceUpdatedAt: legacy.source.updatedAt,
        generatorAgent: 'codex',
        generatorModel: 'gpt-5'
      })
    ).toBe(false)
  })
})
