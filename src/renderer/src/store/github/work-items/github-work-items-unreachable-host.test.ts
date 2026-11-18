import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '../github-slice-test-harness'
import type { Repo } from '../../../../../shared/repository/repo-types'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/laptop/site',
  displayName: 'Site',
  badgeColor: '#000',
  addedAt: 1
}
const serverRepo: Repo = {
  id: 'server-repo',
  path: '/server/plugins',
  displayName: 'Plugins',
  badgeColor: '#000',
  addedAt: 2,
  executionHostId: 'runtime:server-1'
}

describe('work items across hosts when a paired server is known unreachable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    // A powered-off server never answers.
    runtimeEnvironmentCall.mockImplementation(() => new Promise(() => {}))
    mockApi.gh.listWorkItems.mockResolvedValue({
      items: [
        {
          id: 'pr-7',
          type: 'pr',
          number: 7,
          title: 'Local PR',
          state: 'open',
          url: 'https://github.com/o/site/pull/7',
          labels: [],
          updatedAt: '2026-11-01T00:00:00Z',
          author: 'octo'
        }
      ],
      sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    })
  })

  it('answers with the other hosts without asking that server', async () => {
    const store = createTestStore()
    store.setState({ repos: [localRepo, serverRepo] })

    const result = await store.getState().fetchWorkItemsAcrossRepos(
      [
        { repoId: localRepo.id, path: localRepo.path },
        {
          repoId: serverRepo.id,
          path: serverRepo.path,
          executionHostId: serverRepo.executionHostId,
          hostUnreachable: true
        }
      ],
      24,
      24,
      ''
    )

    expect(result?.items.map((item) => [item.repoId, item.number])).toEqual([['local-repo', 7]])
    expect(result?.failedCount).toBe(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
