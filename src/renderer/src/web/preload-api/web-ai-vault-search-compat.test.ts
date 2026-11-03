import { beforeEach, describe, expect, it, vi } from 'vitest'
import { searchResults } from '../../../../shared/ai-vault-search-test-fixture'
import { unavailableSessionSearchStatus } from '../../../../shared/ai-vault-search-client'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'

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
      limit: 20,
      supportedAgents: [...AI_VAULT_AGENTS],
      supportsQoderHistory: true,
      supportsJcodeHistory: true
    })
    expect(result).toMatchObject({ kind: 'results', hits: [{ source: { presence: 'present' } }] })
    expect(JSON.stringify(result)).not.toContain('resumeCommand')
    expect(result).not.toHaveProperty('debug')
    callRuntimeResult.mockResolvedValue(unavailableSessionSearchStatus())
    expect(await api.searchStatus()).toEqual(unavailableSessionSearchStatus())
    expect(callRuntimeResult).toHaveBeenLastCalledWith('aiVault.searchStatus', {})
  })
})

describe('web project conversation listing', () => {
  it('forwards unlimited structured history so older browser conversations are not capped', async () => {
    callRuntimeResult.mockResolvedValue({
      sessions: [],
      issues: [],
      scannedAt: '2026-10-29T00:00:00Z'
    })
    await createWebAiVaultApi().listSessions({
      executionHostScope: 'runtime:owning-host',
      includeStructuredSessions: true,
      unlimited: true
    })
    expect(callRuntimeResult).toHaveBeenCalledExactlyOnceWith(
      'aiVault.listSessions',
      expect.objectContaining({
        executionHostId: 'runtime:owning-host',
        includeStructuredSessions: true,
        unlimited: true
      })
    )
  })
})
