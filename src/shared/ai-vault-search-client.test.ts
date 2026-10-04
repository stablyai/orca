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

describe('Reasonix history search with older hosts', () => {
  it('removes an unsupported Reasonix filter before the old closed-enum request', async () => {
    const call = vi.fn(async (method: string, _params: Record<string, unknown>) =>
      method === 'aiVault.searchStatus'
        ? { ...unavailableSessionSearchStatus(), enabled: true, generation: 9, dshHistory: true }
        : searchResults()
    )
    await createSessionSearchClient(call, 'relay').searchSessions({
      query: 'needle',
      cursor: 'retained-cursor',
      filters: { agents: ['reasonix', 'dsh', 'codex'], scopePaths: ['/host/folder'] }
    })
    expect(call).toHaveBeenLastCalledWith(
      'aiVault.searchSessions',
      expect.objectContaining({
        cursor: 'retained-cursor',
        filters: { agents: ['dsh', 'codex'], scopePaths: ['/host/folder'] }
      })
    )
  })
  it('returns no selected-agent results without widening to all old agents', async () => {
    const call = vi.fn(async () => ({
      ...unavailableSessionSearchStatus(),
      enabled: true,
      generation: 9
    }))
    const result = await createSessionSearchClient(call, 'runtime').searchSessions({
      query: 'needle',
      filters: { agents: ['reasonix'] }
    })
    expect(result).toMatchObject({
      kind: 'results',
      hits: [],
      generation: 9,
      page: { cursor: null, hasMore: false }
    })
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
  })
  it('keeps advertised Reasonix selection and propagates host refusal', async () => {
    const call = vi.fn(async (method: string, _params: Record<string, unknown>) => {
      if (method === 'aiVault.searchStatus') {
        return { ...unavailableSessionSearchStatus(), reasonixHistory: true }
      }
      throw new Error('owning host refused')
    })
    await expect(
      createSessionSearchClient(call, 'relay').searchSessions({
        query: 'needle',
        filters: { agents: ['reasonix'] }
      })
    ).rejects.toThrow('owning host refused')
    expect(call).toHaveBeenLastCalledWith(
      'aiVault.searchSessions',
      expect.objectContaining({ includeReasonixHistory: true, filters: { agents: ['reasonix'] } })
    )
  })
})
