import { describe, expect, it, vi } from 'vitest'
import {
  buildAiVaultRerankPrompt,
  parseAiVaultRerankOutput,
  searchAiVaultSessionsWithAi,
  toAiVaultSessionRankCard
} from './ai-vault-session-ai-query'
import { AiVaultSessionSearchIndex } from './ai-vault-session-index'
import { createAiVaultTestSession } from './ai-vault-session-test-session'

describe('searchAiVaultSessionsWithAi', () => {
  it('recalls natural-language queries from the index and reranks with a mocked model', async () => {
    const linux = createAiVaultTestSession({
      id: 'claude:linux',
      title: 'Fix pairing on Linux',
      previewMessages: [
        { role: 'user', text: 'The PR that repaired Linux pairing flakes', timestamp: null }
      ]
    })
    const wizard = createAiVaultTestSession({
      id: 'codex:wizard',
      agent: 'codex',
      title: 'Onboarding wizard rewrite'
    })
    const index = new AiVaultSessionSearchIndex()
    index.sync([linux, wizard])
    const rerank = vi.fn(async (_query: string, cards: readonly { id: string }[]) => ({
      rankedIds: cards.map((card) => card.id),
      usedModel: true
    }))

    const result = await searchAiVaultSessionsWithAi({
      sessions: [linux, wizard],
      filters: {
        query: 'the PR where we fixed pairing on Linux',
        agents: ['claude', 'codex'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePaths: [],
        hideEmptySessions: true,
        searchScope: 'summary'
      },
      options: { index },
      rerank
    })

    expect(result.usedModel).toBe(true)
    expect(result.sessions.map((session) => session.id)[0]).toBe('claude:linux')
    expect(rerank).toHaveBeenCalledOnce()
    expect(rerank.mock.calls[0]?.[1].some((card) => card.id === 'claude:linux')).toBe(true)
  })

  it('stays on lexical recall when no model callback is provided', async () => {
    const session = createAiVaultTestSession({
      id: 'claude:1',
      title: 'Linux pairing'
    })
    const index = new AiVaultSessionSearchIndex()
    index.sync([session])

    const result = await searchAiVaultSessionsWithAi({
      sessions: [session],
      filters: {
        query: 'pairing',
        agents: ['claude'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePaths: [],
        hideEmptySessions: true,
        searchScope: 'title'
      },
      options: { index }
    })

    expect(result.usedModel).toBe(false)
    expect(result.sessions.map((entry) => entry.id)).toEqual(['claude:1'])
  })

  it('preserves usedModel: false from a successful lexical fallback rerank', async () => {
    const session = createAiVaultTestSession({
      id: 'claude:1',
      title: 'Linux pairing'
    })
    const rerank = vi.fn(async () => ({
      rankedIds: ['claude:1'],
      usedModel: false
    }))

    const result = await searchAiVaultSessionsWithAi({
      sessions: [session],
      filters: {
        query: 'pairing',
        agents: ['claude'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePaths: [],
        hideEmptySessions: true,
        searchScope: 'title'
      },
      rerank
    })

    expect(result.usedModel).toBe(false)
    expect(result.sessions.map((entry) => entry.id)).toEqual(['claude:1'])
  })
})

describe('AI vault rerank prompt parsing', () => {
  it('extracts ranked ids from JSON and keeps unknown ids out', () => {
    expect(
      parseAiVaultRerankOutput('```json\n["claude:2","missing","claude:1"]\n```', [
        'claude:1',
        'claude:2'
      ])
    ).toEqual(['claude:2', 'claude:1'])
  })

  it('includes query and compact cards in the prompt', () => {
    const prompt = buildAiVaultRerankPrompt('linux pairing', [
      toAiVaultSessionRankCard(
        createAiVaultTestSession({
          id: 'claude:1',
          title: 'Fix pairing'
        })
      )
    ])
    expect(prompt).toContain('linux pairing')
    expect(prompt).toContain('id=claude:1')
    expect(prompt).toContain('Fix pairing')
  })
})
