import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectViewCacheKey } from '../github/cache-identity'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'
import type { AppState } from '../types'

describe('createGitHubSlice.fetchWorkItems source/error envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
  })

  it('routes project table fetches through the active runtime environment', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' }
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: {
        ok: true,
        data: {
          project: {
            id: 'project-1',
            owner: 'acme',
            ownerType: 'organization',
            number: 1,
            title: 'Roadmap',
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
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    const result = await store.getState().fetchProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 1,
      viewId: 'view-1'
    })

    expect(result.ok).toBe(true)
    expect(mockApi.gh.getProjectViewTable).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.project.viewTable',
      params: {
        owner: 'acme',
        ownerType: 'organization',
        projectNumber: 1,
        viewId: 'view-1'
      },
      timeoutMs: 60_000
    })
  })

  it('keeps GitHub project view caches separate for runtime and local sources', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' }
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: {
        ok: true,
        data: {
          project: {
            id: 'project-remote',
            owner: 'acme',
            ownerType: 'organization',
            number: 1,
            title: 'Remote Roadmap',
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
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await store.getState().fetchProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 1,
      viewId: 'view-1'
    })

    store.setState({
      settings: { activeRuntimeEnvironmentId: null }
    } as Partial<AppState>)
    mockApi.gh.getProjectViewTable.mockResolvedValueOnce({
      ok: true,
      data: {
        project: {
          id: 'project-local',
          owner: 'acme',
          ownerType: 'organization',
          number: 1,
          title: 'Local Roadmap',
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
    })

    const localResult = await store.getState().fetchProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 1,
      viewId: 'view-1'
    })

    expect(localResult.ok).toBe(true)
    expect(mockApi.gh.getProjectViewTable).toHaveBeenCalledTimes(1)
    expect(
      store.getState().projectViewCache[
        projectViewCacheKey('organization', 'acme', 1, 'view-1', undefined, 'runtime:env-1')
      ]?.data?.project.id
    ).toBe('project-remote')
    expect(
      store.getState().projectViewCache[projectViewCacheKey('organization', 'acme', 1, 'view-1')]
        ?.data?.project.id
    ).toBe('project-local')
  })

  it('keeps same-named github.com and GHES project cache entries separate', async () => {
    const store = createTestStore()
    const makeTable = (host: string, id: string) => ({
      project: {
        id,
        host,
        owner: 'acme',
        ownerType: 'organization' as const,
        number: 1,
        title: id,
        url: `https://${host}/orgs/acme/projects/1`
      },
      selectedView: {
        id: 'view-1',
        number: 1,
        name: 'Table',
        layout: 'TABLE_LAYOUT' as const,
        filter: '',
        fields: [],
        groupByFields: [],
        sortByFields: []
      },
      rows: [],
      totalCount: 0,
      parentFieldDropped: false
    })
    mockApi.gh.getProjectViewTable
      .mockResolvedValueOnce({ ok: true, data: makeTable('github.com', 'dotcom-project') })
      .mockResolvedValueOnce({ ok: true, data: makeTable('ghe.example', 'enterprise-project') })

    for (const host of ['github.com', 'ghe.example']) {
      await store.getState().fetchProjectViewTable({
        owner: 'acme',
        ownerType: 'organization',
        projectNumber: 1,
        viewId: 'view-1',
        host
      })
    }

    expect(mockApi.gh.getProjectViewTable).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ host: 'ghe.example' })
    )
    expect(
      store.getState().projectViewCache[
        projectViewCacheKey('organization', 'acme', 1, 'view-1', undefined, 'local', 'ghe.example')
      ]?.data?.project.id
    ).toBe('enterprise-project')
    expect(
      store.getState().projectViewCache[
        projectViewCacheKey('organization', 'acme', 1, 'view-1', undefined, 'local', 'github.com')
      ]?.data?.project.id
    ).toBe('dotcom-project')
  })

  it('routes project field mutations through the source encoded in the cache key', async () => {
    const store = createTestStore()
    const cacheKey = projectViewCacheKey(
      'organization',
      'acme',
      1,
      'view-1',
      undefined,
      'runtime:env-project',
      'ghe.example:8443'
    )
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' },
      projectViewCache: {
        [cacheKey]: {
          fetchedAt: 1,
          data: {
            project: {
              id: 'project-1',
              host: 'ghe.example:8443',
              owner: 'acme',
              ownerType: 'organization',
              number: 1,
              title: 'Roadmap',
              url: 'https://github.com/orgs/acme/projects/1'
            },
            selectedView: {
              id: 'view-1',
              number: 1,
              name: 'Table',
              layout: 'TABLE_LAYOUT',
              filter: '',
              fields: [{ id: 'field-1', name: 'Notes', dataType: 'TEXT', kind: 'text' }],
              groupByFields: [],
              sortByFields: []
            },
            rows: [
              {
                id: 'row-1',
                itemType: 'ISSUE',
                content: {
                  repository: 'acme/repo',
                  number: 12,
                  title: 'Issue',
                  body: '',
                  url: 'https://github.com/acme/repo/issues/12',
                  state: 'OPEN',
                  labels: [],
                  assignees: [],
                  issueType: null,
                  parentIssue: null
                },
                fieldValuesByFieldId: {}
              }
            ],
            totalCount: 1,
            parentFieldDropped: false
          }
        }
      }
    } as unknown as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-field',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'remote-runtime' }
    })

    const result = await store
      .getState()
      .updateProjectFieldValue(cacheKey, 'row-1', 'field-1', { kind: 'text', text: 'next' })

    expect(result).toEqual({ ok: true })
    expect(mockApi.gh.updateProjectItemField).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-project',
      method: 'github.project.updateItemField',
      params: {
        projectId: 'project-1',
        host: 'ghe.example:8443',
        itemId: 'row-1',
        fieldId: 'field-1',
        value: { kind: 'text', text: 'next' }
      },
      timeoutMs: 30_000
    })
  })

  it('routes slug-only project row mutations through the source encoded in the cache key', async () => {
    const store = createTestStore()
    const cacheKey = projectViewCacheKey(
      'organization',
      'acme',
      1,
      'view-1',
      undefined,
      'runtime:env-project'
    )
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' },
      repos: [],
      projectViewCache: {
        [cacheKey]: {
          fetchedAt: 1,
          data: {
            project: {
              id: 'project-1',
              owner: 'acme',
              ownerType: 'organization',
              number: 1,
              title: 'Roadmap',
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
            rows: [
              {
                id: 'row-1',
                itemType: 'ISSUE',
                content: {
                  repository: 'acme/repo',
                  number: 12,
                  title: 'Issue',
                  body: '',
                  url: 'https://github.com/acme/repo/issues/12',
                  state: 'OPEN',
                  labels: [],
                  assignees: [],
                  issueType: null,
                  parentIssue: null
                },
                fieldValuesByFieldId: {}
              }
            ],
            totalCount: 1,
            parentFieldDropped: false
          }
        }
      }
    } as unknown as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-issue',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'remote-runtime' }
    })

    const result = await store
      .getState()
      .patchProjectIssueOrPr(cacheKey, 'row-1', { addLabels: ['bug'] })

    expect(result).toEqual({ ok: true })
    expect(mockApi.gh.updateIssueBySlug).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-project',
      method: 'github.project.updateIssueBySlug',
      params: {
        owner: 'acme',
        repo: 'repo',
        number: 12,
        updates: { addLabels: ['bug'] }
      },
      timeoutMs: 30_000
    })
  })

  it('optimistically patches a project field and rolls back an ok:false result', async () => {
    const store = createTestStore()
    const cacheKey = projectViewCacheKey('organization', 'acme', 1, 'view-1')
    store.setState({
      settings: { activeRuntimeEnvironmentId: null },
      projectViewCache: {
        [cacheKey]: {
          fetchedAt: 1,
          data: {
            project: {
              id: 'project-1',
              owner: 'acme',
              ownerType: 'organization',
              number: 1,
              title: 'Roadmap',
              url: 'https://github.com/orgs/acme/projects/1'
            },
            selectedView: {
              id: 'view-1',
              number: 1,
              name: 'Table',
              layout: 'TABLE_LAYOUT',
              filter: '',
              fields: [{ id: 'field-1', name: 'Notes', dataType: 'TEXT', kind: 'text' }],
              groupByFields: [],
              sortByFields: []
            },
            rows: [
              {
                id: 'row-1',
                itemType: 'ISSUE',
                content: {
                  repository: 'acme/repo',
                  number: 12,
                  title: 'Issue',
                  body: '',
                  url: 'https://github.com/acme/repo/issues/12',
                  state: 'OPEN',
                  labels: [],
                  assignees: [],
                  issueType: null,
                  parentIssue: null
                },
                fieldValuesByFieldId: {
                  'field-1': { kind: 'text', fieldId: 'field-1', text: 'before' }
                }
              }
            ],
            totalCount: 1,
            parentFieldDropped: false
          }
        }
      }
    } as unknown as Partial<AppState>)
    const mutationResult = Promise.withResolvers<{ ok: false; error: string }>()
    mockApi.gh.updateProjectItemField.mockReturnValueOnce(mutationResult.promise)

    const mutation = store
      .getState()
      .updateProjectFieldValue(cacheKey, 'row-1', 'field-1', { kind: 'text', text: 'after' })
    expect(
      store.getState().projectViewCache[cacheKey]?.data?.rows[0]?.fieldValuesByFieldId['field-1']
    ).toEqual({ kind: 'text', fieldId: 'field-1', text: 'after' })

    mutationResult.resolve({ ok: false, error: 'rejected' })
    await expect(mutation).resolves.toEqual({ ok: false, error: 'rejected' })
    expect(
      store.getState().projectViewCache[cacheKey]?.data?.rows[0]?.fieldValuesByFieldId['field-1']
    ).toEqual({ kind: 'text', fieldId: 'field-1', text: 'before' })
  })

  it('bounds project view table cache entries across many projects', async () => {
    vi.useFakeTimers()

    try {
      const store = createTestStore()
      mockApi.gh.getProjectViewTable.mockImplementation(
        async (args: Parameters<AppState['fetchProjectViewTable']>[0]) => ({
          ok: true,
          data: {
            project: {
              id: `project-${args.projectNumber}`,
              owner: args.owner,
              ownerType: args.ownerType,
              number: args.projectNumber,
              title: 'Roadmap',
              url: `https://github.com/orgs/${args.owner}/projects/${args.projectNumber}`
            },
            selectedView: {
              id: args.viewId ?? `view-${args.projectNumber}`,
              number: args.projectNumber,
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
        })
      )

      for (let i = 0; i <= 500; i++) {
        vi.setSystemTime(1_000 + i)
        await store.getState().fetchProjectViewTable(
          {
            owner: 'acme',
            ownerType: 'organization',
            projectNumber: i,
            viewId: `view-${i}`
          },
          { force: true }
        )
      }

      const cache = store.getState().projectViewCache
      expect(Object.keys(cache)).toHaveLength(500)
      expect(projectViewCacheKey('organization', 'acme', 0, 'view-0') in cache).toBe(false)
      expect(projectViewCacheKey('organization', 'acme', 500, 'view-500') in cache).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
