// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../../../shared/ai-vault-search-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import { searchResults } from '../../../../shared/ai-vault-search-test-fixture'
import { aiVaultSearchScopeIdentity } from './ai-vault-search-scope-identity'
import { useAiVaultPanelSearch } from './use-ai-vault-search'

vi.mock('@/store', () => ({
  useAppStore: (select: (state: { settings: undefined }) => unknown) =>
    select({ settings: undefined })
}))

const AGENTS = ['codex' as const]
// Stable, the way the panel memoizes it: the hook keys its request on the reference.
const WORKSPACE = { kind: 'workspace', worktreeId: 'repo-1::/work/app' } as const
const searchSessions =
  vi.fn<
    (request: AiVaultSearchRequest, scope?: ExecutionHostScope) => Promise<AiVaultSearchResponse>
  >()

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchSessions } }
  })
  searchSessions.mockReset().mockResolvedValue(searchResults())
})
afterEach(() => vi.useRealTimers())

async function debounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
}

describe('the panel scope as a request carries it', () => {
  it('names the active workspace', () => {
    expect(
      aiVaultSearchScopeIdentity({
        scope: 'workspace',
        activeWorktreeId: 'repo-1::/work/app',
        activeProjectKey: 'repo:repo-1'
      })
    ).toEqual({ kind: 'workspace', worktreeId: 'repo-1::/work/app' })
  })

  it('names the active project', () => {
    expect(
      aiVaultSearchScopeIdentity({
        scope: 'project',
        activeWorktreeId: 'repo-1::/work/app',
        activeProjectKey: 'project:proj-1'
      })
    ).toEqual({ kind: 'project', projectKey: 'project:proj-1' })
  })

  it('sends nothing for All, which still means every session the host has', () => {
    expect(
      aiVaultSearchScopeIdentity({
        scope: 'all',
        activeWorktreeId: 'repo-1::/work/app',
        activeProjectKey: 'repo:repo-1'
      })
    ).toBeUndefined()
  })

  it('sends nothing when the scope has no subject yet', () => {
    expect(
      aiVaultSearchScopeIdentity({
        scope: 'project',
        activeWorktreeId: null,
        activeProjectKey: null
      })
    ).toBeUndefined()
  })
})

describe('the panel hook under a scope identity', () => {
  it('sends the identity and no path list', async () => {
    const within = { kind: 'project', projectKey: 'repo:repo-1' } as const
    const { unmount } = renderHook(() =>
      useAiVaultPanelSearch('needle', AGENTS, within, 'ssh:build-box', 'relevance')
    )
    await debounce()
    expect(searchSessions).toHaveBeenCalledExactlyOnceWith(
      { query: 'needle', filters: { agents: ['codex'] }, within, cursor: undefined },
      'ssh:build-box'
    )
    unmount()
  })

  it('does not restart the search while the identity holds', async () => {
    const { rerender, unmount } = renderHook(() =>
      useAiVaultPanelSearch('needle', AGENTS, WORKSPACE, 'ssh:build-box', 'relevance')
    )
    await debounce()
    rerender()
    rerender()
    await debounce()
    expect(searchSessions).toHaveBeenCalledTimes(1)
    unmount()
  })
})
