import { beforeEach, describe, expect, it, vi } from 'vitest'
import { searchResults } from '../../../../shared/ai-vault-search-test-fixture'
import { unavailableSessionSearchStatus } from '../../../../shared/ai-vault-search-client'

const callRuntimeResult = vi.hoisted(() => vi.fn())
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironment: () => ({ id: 'owning-host' })
}))
import { createWebAiVaultApi } from './web-ai-vault-api'

beforeEach(() => {
  callRuntimeResult.mockReset()
})

describe('web session search preload compatibility', () => {
  it('calls the selected host, parses its response and applies remote exposure', async () => {
    callRuntimeResult.mockResolvedValue(searchResults())
    const api = createWebAiVaultApi()
    const result = await api.searchSessions({ query: 'needle' })
    expect(callRuntimeResult).toHaveBeenCalledExactlyOnceWith('aiVault.searchSessions', {
      query: 'needle',
      limit: 20
    })
    expect(result).toMatchObject({ kind: 'results', hits: [{ source: { presence: 'present' } }] })
    expect(JSON.stringify(result)).not.toContain('resumeCommand')
    expect(result).not.toHaveProperty('debug')
    callRuntimeResult.mockResolvedValue(unavailableSessionSearchStatus())
    expect(await api.searchStatus()).toEqual(unavailableSessionSearchStatus())
    expect(callRuntimeResult).toHaveBeenLastCalledWith('aiVault.searchStatus', {})
  })
  it('treats an old host as unavailable but propagates transport failures', async () => {
    const api = createWebAiVaultApi()
    callRuntimeResult.mockRejectedValue(
      Object.assign(new Error('unknown method'), { code: 'method_not_found' })
    )
    expect(await api.searchSessions({ query: 'needle' })).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
    expect(await api.searchStatus()).toEqual(unavailableSessionSearchStatus())
    callRuntimeResult.mockRejectedValue(
      Object.assign(new Error('disconnected'), { code: 'connection_lost' })
    )
    await expect(api.searchSessions({ query: 'needle' })).rejects.toThrow('disconnected')
    await expect(api.searchStatus()).rejects.toThrow('disconnected')
  })
  it('rejects invalid host responses and unsupported SSH selection', async () => {
    const api = createWebAiVaultApi()
    callRuntimeResult.mockResolvedValue({ kind: 'results' })
    await expect(api.searchSessions({ query: 'needle' })).rejects.toThrow()
    await expect(api.searchStatus()).rejects.toThrow()
    callRuntimeResult.mockClear()
    await expect(api.searchSessions({ query: 'needle' }, 'other-host')).rejects.toThrow(
      'transcript-owning runtime'
    )
    await expect(api.searchStatus('other-host')).rejects.toThrow('transcript-owning runtime')
    expect(callRuntimeResult).not.toHaveBeenCalled()
  })
})
