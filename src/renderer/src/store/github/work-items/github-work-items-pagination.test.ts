import { answered } from '../requests/answered-request.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '../github-slice-test-harness'
import '../../testing/app-store-test-fixture'

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

  it('rejects provider-side partial data from a complete later-page result', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [
        {
          id: 'issue:1',
          type: 'issue',
          number: 1,
          title: 'Partial',
          state: 'open',
          url: 'https://github.com/o/r/issues/1',
          labels: [],
          updatedAt: '2026-05-22T00:00:00Z',
          author: 'author'
        }
      ],
      sources: {
        issues: { owner: 'o', repo: 'r' },
        prs: { owner: 'o', repo: 'r' },
        originCandidate: { owner: 'o', repo: 'r' },
        upstreamCandidate: null
      },
      errors: { issues: { type: 'permission_denied', message: 'no access' } }
    })

    const result = answered(
      await store
        .getState()
        .fetchWorkItemsNextPage([{ repoId: 'repo-1', path: '/repo' }], 24, 100, '', 2, {
          requireComplete: true
        })
    )

    expect(result.items).toEqual([])
    expect(result.failedCount).toBe(1)
    expect(result.errorTypes).toEqual(['permission_denied'])
  })
})
