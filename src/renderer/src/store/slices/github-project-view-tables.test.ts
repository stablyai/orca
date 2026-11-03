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
        async (args: Parameters<AppState['fetchProjectViewTable']>[1]) => ({
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
          { kind: 'local' },
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
