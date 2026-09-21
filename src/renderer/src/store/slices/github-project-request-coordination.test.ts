import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubProjectTable } from '../../../../shared/github/project-types'
import type { GetProjectViewTableResult } from '../../../../shared/github/project-result-types'
import { projectViewCacheKey } from '../github/cache-identity'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'

function makeTable(title = 'Roadmap'): GitHubProjectTable {
  return {
    project: {
      id: 'project-1',
      owner: 'acme',
      ownerType: 'organization',
      number: 1,
      title,
      url: 'https://github.com/orgs/acme/projects/1'
    },
    selectedView: {
      id: 'view-1',
      number: 1,
      name: 'Table',
      layout: 'TABLE_LAYOUT',
      filter: '',
      fields: [],
      groupByFields: [],
      sortByFields: []
    },
    rows: [],
    totalCount: 0,
    parentFieldDropped: false
  }
}

const request = {
  owner: 'acme',
  ownerType: 'organization' as const,
  projectNumber: 1,
  viewId: 'view-1'
}

const cacheKey = projectViewCacheKey('organization', 'acme', 1, 'view-1')

describe('createGitHubSlice.fetchProjectViewTable coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('returns a fresh known-view cache entry without starting a request', async () => {
    const store = createTestStore()
    const table = makeTable()
    store.setState({ projectViewCache: { [cacheKey]: { data: table, fetchedAt: Date.now() } } })

    await expect(store.getState().fetchProjectViewTable(request)).resolves.toEqual({
      ok: true,
      data: table
    })
    expect(mockApi.gh.getProjectViewTable).not.toHaveBeenCalled()
  })

  it('deduplicates identical non-forced in-flight requests', async () => {
    const store = createTestStore()
    const pending = Promise.withResolvers<GetProjectViewTableResult>()
    mockApi.gh.getProjectViewTable.mockReturnValueOnce(pending.promise)

    const first = store.getState().fetchProjectViewTable(request)
    const duplicate = store.getState().fetchProjectViewTable(request)
    pending.resolve({ ok: true, data: makeTable() })

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { ok: true, data: makeTable() },
      { ok: true, data: makeTable() }
    ])
    expect(mockApi.gh.getProjectViewTable).toHaveBeenCalledTimes(1)
  })

  it('lets each forced waiter start after a weaker request settles', async () => {
    const store = createTestStore()
    const weak = Promise.withResolvers<GetProjectViewTableResult>()
    mockApi.gh.getProjectViewTable
      .mockReturnValueOnce(weak.promise)
      .mockResolvedValue({ ok: true, data: makeTable('forced') })

    const first = store.getState().fetchProjectViewTable(request)
    const forcedOne = store.getState().fetchProjectViewTable(request, { force: true })
    const forcedTwo = store.getState().fetchProjectViewTable(request, { force: true })
    weak.resolve({ ok: true, data: makeTable('weak') })

    await expect(Promise.all([first, forcedOne, forcedTwo])).resolves.toHaveLength(3)
    expect(mockApi.gh.getProjectViewTable).toHaveBeenCalledTimes(3)
  })

  it('stamps a classified failure onto stale data only when the view key is known', async () => {
    const store = createTestStore()
    const stale = makeTable('stale')
    const error = { type: 'network_error' as const, message: 'offline' }
    store.setState({ projectViewCache: { [cacheKey]: { data: stale, fetchedAt: 1 } } })
    mockApi.gh.getProjectViewTable.mockResolvedValueOnce({ ok: false, error })

    await expect(store.getState().fetchProjectViewTable(request, { force: true })).resolves.toEqual(
      {
        ok: false,
        error
      }
    )
    expect(store.getState().projectViewCache[cacheKey]).toMatchObject({ data: stale, error })

    mockApi.gh.getProjectViewTable.mockResolvedValueOnce({ ok: false, error })
    await expect(
      store.getState().fetchProjectViewTable({
        owner: 'acme',
        ownerType: 'organization',
        projectNumber: 1
      })
    ).resolves.toEqual({ ok: false, error })
    expect(Object.keys(store.getState().projectViewCache)).toEqual([cacheKey])
  })
  it('wraps an unexpected transport throw without stamping an unknown selector', async () => {
    const store = createTestStore()
    mockApi.gh.getProjectViewTable.mockRejectedValueOnce(new Error('transport offline'))

    await expect(
      store.getState().fetchProjectViewTable({
        owner: 'acme',
        ownerType: 'organization',
        projectNumber: 1
      })
    ).resolves.toEqual({
      ok: false,
      error: { type: 'unknown', message: 'transport offline' }
    })
    expect(store.getState().projectViewCache).toEqual({})
  })
})
