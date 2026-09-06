// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiVaultSessionSearchResults } from './ai-vault-session-search-results'
const mocks = vi.hoisted(() => ({ web: false, request: vi.fn() }))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('./ai-vault-session-search-request', () => ({
  useAiVaultSessionSearchRequest: (...args: unknown[]) => {
    mocks.request(...args)
    return { error: null, loading: false, updating: false, result: null }
  }
}))
vi.mock('./ai-vault-search-coverage-poll', () => ({ useAiVaultSearchCoveragePoll: () => null }))
afterEach(cleanup)
beforeEach(() => {
  mocks.web = false
  mocks.request.mockClear()
})
const input = {
  enabled: true,
  query: 'needle repo:unknown path:/other',
  agents: ['claude' as const],
  scopePaths: ['/folder'],
  executionHostScope: 'local' as const,
  sessions: [],
  worktrees: [],
  repos: []
}
describe('session search request boundary', () => {
  it('preserves operators and intersects them with the selected folder at the server', () => {
    renderHook(() => useAiVaultSessionSearchResults(input))
    expect(mocks.request.mock.lastCall?.[0]).toMatchObject({
      query: input.query,
      scopePaths: ['/folder']
    })
  })
  it('does not issue a query when every agent is deselected', () => {
    const { result } = renderHook(() => useAiVaultSessionSearchResults({ ...input, agents: [] }))
    expect(mocks.request.mock.lastCall?.[0]).toBeNull()
    expect(result.current.active).toBe(false)
  })
  it('does not substitute local search for an SSH host', () => {
    const { result } = renderHook(() =>
      useAiVaultSessionSearchResults({ ...input, executionHostScope: 'ssh:host' })
    )
    expect(mocks.request.mock.lastCall?.[0]).toBeNull()
    expect(result.current.localOnly).toBe(true)
  })
  it('keeps operator-only queries on the index path', () => {
    renderHook(() => useAiVaultSessionSearchResults({ ...input, query: 'path:/folder' }))
    expect(mocks.request.mock.lastCall?.[0]).toMatchObject({ query: 'path:/folder' })
  })
  it('allows a web client to search its addressed runtime', () => {
    mocks.web = true
    renderHook(() =>
      useAiVaultSessionSearchResults({ ...input, executionHostScope: 'runtime:test' })
    )
    expect(mocks.request.mock.lastCall?.[0]).not.toBeNull()
  })
})
