import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearCollectionResult } from '../../../../shared/linear/workspace-types'
import { LinearIssueAttributeFilterUnsupportedError } from '@/runtime/runtime-linear-client'
import { createTestStore, deferred, issue } from './linear-slice-test-harness'

const linearStatus = vi.fn()
const linearConnect = vi.fn()
const linearDisconnect = vi.fn()
const linearListIssues = vi.fn()
const linearSearchIssues = vi.fn()
const linearListTeams = vi.fn()
const linearGetIssue = vi.fn()
const linearListProjects = vi.fn()
const linearGetCustomView = vi.fn()
const linearGetProject = vi.fn()
const linearListProjectIssues = vi.fn()
const linearListCustomViews = vi.fn()
const linearListCustomViewIssues = vi.fn()
const linearListCustomViewProjects = vi.fn()
const linearTestConnection = vi.fn()

vi.mock('@/runtime/runtime-linear-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    linearConnect: (...args: unknown[]) => linearConnect(...args),
    linearDisconnect: (...args: unknown[]) => linearDisconnect(...args),
    linearDisconnectWorkspace: vi.fn(),
    linearGetCustomView: (...args: unknown[]) => linearGetCustomView(...args),
    linearGetProject: (...args: unknown[]) => linearGetProject(...args),
    linearGetIssue: (...args: unknown[]) => linearGetIssue(...args),
    linearListCustomViewIssues: (...args: unknown[]) => linearListCustomViewIssues(...args),
    linearListCustomViewProjects: (...args: unknown[]) => linearListCustomViewProjects(...args),
    linearListCustomViews: (...args: unknown[]) => linearListCustomViews(...args),
    linearListIssues: (...args: unknown[]) => linearListIssues(...args),
    linearListProjectIssues: (...args: unknown[]) => linearListProjectIssues(...args),
    linearListProjects: (...args: unknown[]) => linearListProjects(...args),
    linearListTeams: (...args: unknown[]) => linearListTeams(...args),
    linearSearchIssues: (...args: unknown[]) => linearSearchIssues(...args),
    linearSelectWorkspace: vi.fn(),
    linearStatus: (...args: unknown[]) => linearStatus(...args),
    linearTestConnection: (...args: unknown[]) => linearTestConnection(...args)
  }
})

vi.mock('../../hooks/useIssueMetadata', () => ({
  clearLinearMetadataCache: vi.fn()
}))

describe('createLinearSlice caching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('serves fresh list cache and lets forced refresh bypass it', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' }
    })
    linearListIssues
      .mockResolvedValueOnce({ items: [issue('LIN-1')] })
      .mockResolvedValueOnce({ items: [issue('LIN-2')] })

    await expect(
      store.getState().listLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).resolves.toMatchObject({
      items: [{ id: 'LIN-1' }]
    })
    await expect(
      store.getState().listLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).resolves.toMatchObject({
      items: [{ id: 'LIN-1' }]
    })
    await expect(
      store.getState().listLinearIssues({ kind: 'list', filter: 'all', limit: 36 }, { force: true })
    ).resolves.toMatchObject({ items: [{ id: 'LIN-2' }] })

    expect(linearListIssues).toHaveBeenCalledTimes(2)
  })

  it('isolates list cache entries by attribute filter signature', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' }
    })
    const filtered = {
      stateIds: ['state-1'],
      priorities: [1],
      assignee: null as null,
      labelIds: [] as string[]
    }
    linearListIssues
      .mockResolvedValueOnce({ items: [issue('LIN-ALL')] })
      .mockResolvedValueOnce({ items: [issue('LIN-FILTERED')] })

    await store.getState().listLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    await store.getState().listLinearIssues({
      kind: 'list',
      filter: 'all',
      limit: 36,
      attributeFilter: filtered
    })

    expect(linearListIssues).toHaveBeenCalledTimes(2)
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).toMatchObject({ items: [{ id: 'LIN-ALL' }] })
    expect(
      store.getState().getCachedLinearIssues({
        kind: 'list',
        filter: 'all',
        limit: 36,
        attributeFilter: filtered
      })
    ).toMatchObject({ items: [{ id: 'LIN-FILTERED' }] })

    store.getState().invalidateLinearIssueLists()
    expect(
      store.getState().getCachedLinearIssues({
        kind: 'list',
        filter: 'all',
        limit: 36,
        attributeFilter: filtered
      })
    ).toBeNull()
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).toMatchObject({ items: [{ id: 'LIN-ALL' }] })
  })

  it('lets forced list refresh bypass older in-flight reads without stale cache overwrite', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' }
    })
    const staleRequest = deferred<LinearCollectionResult<LinearIssue>>()
    const forcedRequest = deferred<LinearCollectionResult<LinearIssue>>()
    linearListIssues
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(forcedRequest.promise)

    const stalePromise = store
      .getState()
      .listLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    const forcedPromise = store
      .getState()
      .listLinearIssues({ kind: 'list', filter: 'all', limit: 36 }, { force: true })

    expect(linearListIssues).toHaveBeenCalledTimes(2)

    forcedRequest.resolve({ items: [issue('LIN-FORCED')] })
    await expect(forcedPromise).resolves.toMatchObject({ items: [{ id: 'LIN-FORCED' }] })
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).toMatchObject({ items: [{ id: 'LIN-FORCED' }] })

    staleRequest.resolve({ items: [issue('LIN-STALE')] })
    await expect(stalePromise).resolves.toMatchObject({ items: [{ id: 'LIN-STALE' }] })
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).toMatchObject({ items: [{ id: 'LIN-FORCED' }] })
  })

  it('lets forced search refresh bypass older in-flight reads without stale cache overwrite', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' }
    })
    const staleRequest = deferred<LinearIssue[]>()
    const forcedRequest = deferred<LinearIssue[]>()
    linearSearchIssues
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(forcedRequest.promise)

    const stalePromise = store.getState().searchLinearIssues('loading', 36)
    const forcedPromise = store.getState().searchLinearIssues('loading', 36, { force: true })

    expect(linearSearchIssues).toHaveBeenCalledTimes(2)

    forcedRequest.resolve([issue('LIN-FORCED')])
    await expect(forcedPromise).resolves.toMatchObject([{ id: 'LIN-FORCED' }])
    expect(
      store.getState().getCachedLinearIssues({ kind: 'search', query: 'loading', limit: 36 })
    ).toMatchObject([{ id: 'LIN-FORCED' }])

    staleRequest.resolve([issue('LIN-STALE')])
    await expect(stalePromise).resolves.toMatchObject([{ id: 'LIN-STALE' }])
    expect(
      store.getState().getCachedLinearIssues({ kind: 'search', query: 'loading', limit: 36 })
    ).toMatchObject([{ id: 'LIN-FORCED' }])
  })

  it('preserves cached list rows when forced revalidation fails transiently', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearListCache: {
        'workspace-1::list::all::36::': { data: { items: [issue('LIN-CACHED')] }, fetchedAt: 1 }
      }
    })
    linearListIssues.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().listLinearIssues({ kind: 'list', filter: 'all', limit: 36 }, { force: true })
    ).resolves.toMatchObject({ items: [{ id: 'LIN-CACHED' }] })
  })

  it('rethrows attribute-filter unsupported errors so UI can surface an upgrade message', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' }
    })
    const attributeFilter = {
      stateIds: ['state-1'],
      priorities: [] as number[],
      assignee: null as null,
      labelIds: [] as string[]
    }
    // Seed via a successful read so the cache key matches production signing.
    linearListIssues.mockResolvedValueOnce({ items: [issue('LIN-CACHED')] })
    await store.getState().listLinearIssues({
      kind: 'list',
      filter: 'all',
      limit: 36,
      attributeFilter
    })
    linearListIssues.mockRejectedValueOnce(new LinearIssueAttributeFilterUnsupportedError())

    await expect(
      store.getState().listLinearIssues(
        {
          kind: 'list',
          filter: 'all',
          limit: 36,
          attributeFilter
        },
        { force: true }
      )
    ).rejects.toBeInstanceOf(LinearIssueAttributeFilterUnsupportedError)

    // Why: must not replace a warm filtered cache with empty on capability miss.
    expect(
      store.getState().getCachedLinearIssues({
        kind: 'list',
        filter: 'all',
        limit: 36,
        attributeFilter
      })
    ).toMatchObject({ items: [{ id: 'LIN-CACHED' }] })
  })

  it('preserves cached search rows when forced revalidation fails transiently', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearSearchCache: {
        'workspace-1::search::loading::36': { data: [issue('LIN-CACHED')], fetchedAt: 1 }
      }
    })
    linearSearchIssues.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().searchLinearIssues('loading', 36, { force: true })
    ).resolves.toMatchObject([{ id: 'LIN-CACHED' }])
  })

  it('returns stale cached rows for immediate rendering while revalidation decides freshness', () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearListCache: {
        'workspace-1::list::all::36::': { data: { items: [issue('LIN-1')] }, fetchedAt: 1 }
      }
    })

    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).toEqual({ items: [issue('LIN-1')] })
  })

  it('keeps literal search queries separate from list cache keys', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearListCache: {
        'workspace-1::list::all::36::': { data: { items: [issue('LIST')] }, fetchedAt: Date.now() }
      }
    })
    linearSearchIssues.mockResolvedValueOnce([issue('SEARCH')])

    await expect(store.getState().searchLinearIssues('list::all', 36)).resolves.toMatchObject([
      { id: 'SEARCH' }
    ])

    expect(linearSearchIssues).toHaveBeenCalledTimes(1)
    expect(
      store.getState().getCachedLinearIssues({ kind: 'search', query: 'list::all', limit: 36 })
    ).toMatchObject([{ id: 'SEARCH' }])
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).toMatchObject({ items: [{ id: 'LIST' }] })
  })
})
