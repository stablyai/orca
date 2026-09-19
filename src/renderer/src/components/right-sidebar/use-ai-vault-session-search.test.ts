import { describe, expect, it, vi } from 'vitest'
import { searchAiVaultSessionsWithAi } from '../../../../shared/ai-vault-session-ai-query'
import { createAiVaultTestSession } from '../../../../shared/ai-vault-session-test-session'

describe('session history AI retrieval', () => {
  it('returns ranked sessions from the shared AI query path', async () => {
    const session = createAiVaultTestSession({
      id: 'claude:1',
      title: 'Linux pairing'
    })
    const rerank = vi.fn(async () => ({ rankedIds: ['claude:1'], usedModel: true }))

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

    expect(result.usedModel).toBe(true)
    expect(result.sessions.map((entry) => entry.id)).toEqual(['claude:1'])
  })
})
