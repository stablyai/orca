import { describe, expect, it, vi } from 'vitest'
import { createSessionSearchClient, unavailableSessionSearchStatus } from './ai-vault-search-client'
import { searchResults } from './ai-vault-search-test-fixture'

describe('DSH history search with older hosts', () => {
  it('removes only the new agent filter before calling an older host', async () => {
    const call = vi.fn(async (method: string, _params: Record<string, unknown>) =>
      method === 'aiVault.searchStatus'
        ? { ...unavailableSessionSearchStatus(), enabled: true, generation: 9 }
        : searchResults()
    )
    const client = createSessionSearchClient(call, 'relay')
    await client.searchSessions({
      query: 'needle',
      filters: { agents: ['dsh', 'codex'], scopePaths: ['/host/folder'] }
    })
    expect(call).toHaveBeenLastCalledWith(
      'aiVault.searchSessions',
      expect.objectContaining({
        filters: { agents: ['codex'], scopePaths: ['/host/folder'] },
        includeDshHistory: true
      })
    )
  })
  it('returns no DSH matches on an older host instead of searching every agent', async () => {
    const call = vi.fn(async () => ({
      ...unavailableSessionSearchStatus(),
      enabled: true,
      generation: 9
    }))
    const result = await createSessionSearchClient(call, 'relay').searchSessions({
      query: 'needle',
      filters: { agents: ['dsh'] }
    })
    expect(result).toMatchObject({ kind: 'results', hits: [], generation: 9 })
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('aiVault.searchStatus', {})
  })
})
