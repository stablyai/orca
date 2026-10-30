import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubProjectTable } from '../../../../shared/github/project-types'
import type { GetProjectViewTableResult } from '../../../../shared/github/project-result-types'
import { projectViewCacheKey, projectViewSourceScope } from '../github/cache-identity'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'
import { projectRelationsTableFixture } from '../../../../shared/github/project-relations.test-fixture'
import { projectRelationCellText } from '../../components/github-project/ProjectCell.test-fixture'
import { sortRows, groupRows } from '../../../../shared/github/project-group-sort'

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

    await expect(
      store.getState().fetchProjectViewTable({ kind: 'local' }, request)
    ).resolves.toEqual({
      ok: true,
      data: table
    })
    expect(mockApi.gh.getProjectViewTable).not.toHaveBeenCalled()
  })

  it.each([{ kind: 'local' }, { kind: 'environment', environmentId: 'env-board' }] as const)(
    'preserves populated and legacy cells through the $kind cache',
    async (target) => {
      const table = projectRelationsTableFixture()
      const store = createTestStore()
      const envelope = { ok: true, data: table }
      if (target.kind === 'local') {
        mockApi.gh.getProjectViewTable.mockResolvedValueOnce(envelope)
      } else {
        runtimeEnvironmentCall.mockResolvedValueOnce({
          id: 'rpc-project',
          ok: true,
          result: envelope,
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      expect(await store.getState().fetchProjectViewTable(target, request)).toEqual(envelope)
      const key = projectViewCacheKey(
        'organization',
        'acme',
        1,
        'view-1',
        undefined,
        projectViewSourceScope(target)
      )
      const cached = store.getState().projectViewCache[key]?.data
      if (!cached) {
        throw new Error('Expected cached table')
      }
      expect(cached).toEqual(table)
      const groups = groupRows(cached, sortRows(cached, cached.rows))
      expect(groups.map((group) => group.label)).toEqual(['1', '2'])
      expect(groups.flatMap((group) => group.rows.map(projectRelationCellText))).toEqual([
        ['', ''],
        ['#12 +2', '1/2 (50%)']
      ])
      expect(cached.rows[1].content).not.toHaveProperty('linkedPullRequests')
      expect(cached.rows[1].content).not.toHaveProperty('subIssuesProgress')
      expect(await store.getState().fetchProjectViewTable(target, request)).toEqual(envelope)
      if (target.kind === 'local') {
        expect(mockApi.gh.getProjectViewTable).toHaveBeenCalledTimes(1)
        expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
      } else {
        expect(mockApi.gh.getProjectViewTable).not.toHaveBeenCalled()
        expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
        expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
          expect.objectContaining({
            selector: 'env-board',
            method: 'github.project.viewTable',
            params: request
          })
        )
      }
    }
  )

  it('deduplicates identical non-forced in-flight requests', async () => {
    const store = createTestStore()
    const pending = Promise.withResolvers<GetProjectViewTableResult>()
    mockApi.gh.getProjectViewTable.mockReturnValueOnce(pending.promise)

    const first = store.getState().fetchProjectViewTable({ kind: 'local' }, request)
    const duplicate = store.getState().fetchProjectViewTable({ kind: 'local' }, request)
    pending.resolve({ ok: true, data: makeTable() })

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { ok: true, data: makeTable() },
      { ok: true, data: makeTable() }
    ])
    expect(mockApi.gh.getProjectViewTable).toHaveBeenCalledTimes(1)
  })

  it('shares one fresh request across twenty forced waiters after a weaker request', async () => {
    const store = createTestStore()
    const weak = Promise.withResolvers<GetProjectViewTableResult>()
    mockApi.gh.getProjectViewTable
      .mockReturnValueOnce(weak.promise)
      .mockResolvedValue({ ok: true, data: makeTable('forced') })

    const first = store.getState().fetchProjectViewTable({ kind: 'local' }, request)
    const forced = Array.from({ length: 20 }, () =>
      store.getState().fetchProjectViewTable({ kind: 'local' }, request, { force: true })
    )
    weak.resolve({ ok: true, data: makeTable('weak') })

    await expect(first).resolves.toEqual({ ok: true, data: makeTable('weak') })
    await expect(Promise.all(forced)).resolves.toEqual(
      Array.from({ length: 20 }, () => ({ ok: true, data: makeTable('forced') }))
    )
    expect(mockApi.gh.getProjectViewTable).toHaveBeenCalledTimes(2)
  })

  it('stamps a classified failure onto stale data only when the view key is known', async () => {
    const store = createTestStore()
    const stale = makeTable('stale')
    const error = { type: 'network_error' as const, message: 'offline' }
    store.setState({ projectViewCache: { [cacheKey]: { data: stale, fetchedAt: 1 } } })
    mockApi.gh.getProjectViewTable.mockResolvedValueOnce({ ok: false, error })

    await expect(
      store.getState().fetchProjectViewTable({ kind: 'local' }, request, { force: true })
    ).resolves.toEqual({
      ok: false,
      error
    })
    expect(store.getState().projectViewCache[cacheKey]).toMatchObject({ data: stale, error })

    mockApi.gh.getProjectViewTable.mockResolvedValueOnce({ ok: false, error })
    await expect(
      store.getState().fetchProjectViewTable(
        { kind: 'local' },
        {
          owner: 'acme',
          ownerType: 'organization',
          projectNumber: 1
        }
      )
    ).resolves.toEqual({ ok: false, error })
    expect(Object.keys(store.getState().projectViewCache)).toEqual([cacheKey])
  })
  it('wraps an unexpected transport throw without stamping an unknown selector', async () => {
    const store = createTestStore()
    mockApi.gh.getProjectViewTable.mockRejectedValueOnce(new Error('transport offline'))

    await expect(
      store.getState().fetchProjectViewTable(
        { kind: 'local' },
        {
          owner: 'acme',
          ownerType: 'organization',
          projectNumber: 1
        }
      )
    ).resolves.toEqual({
      ok: false,
      error: { type: 'unknown', message: 'transport offline' }
    })
    expect(store.getState().projectViewCache).toEqual({})
  })
})
