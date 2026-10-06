import { beforeEach, describe, expect, it, vi } from 'vitest'
import { issueCacheKey } from '../github/cache-identity'
import {
  createTestStore,
  githubSourceContext,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'

const fork = { owner: 'fork', repo: 'repo', host: 'github.com' }
const parent = { owner: 'parent', repo: 'repo', host: 'github.com' }

describe('linked issue cache and routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.issue.mockResolvedValue(null)
  })

  it('ignores the old upstream cache when the linked URL pins the fork', async () => {
    const store = createTestStore()
    store.setState({
      issueCache: {
        [issueCacheKey('/repo', 'repo-1', 247)]: { data: null, fetchedAt: Date.now() }
      }
    })
    await store.getState().fetchIssue('/repo', 247, { repoId: 'repo-1', ownerRepo: fork })
    expect(mockApi.gh.issue).toHaveBeenCalledWith({
      repoPath: '/repo',
      repoId: 'repo-1',
      number: 247,
      sourceContext: undefined,
      ownerRepo: fork
    })
  })

  it('keeps same-number repositories and hosts separate, but deduplicates one target', async () => {
    const store = createTestStore()
    const enterprise = { ...fork, host: 'git.example.com' }
    await Promise.all(
      [fork, parent, enterprise, { ...fork, owner: 'FORK' }].map((ownerRepo) =>
        store.getState().fetchIssue('/repo', 247, { repoId: 'repo-1', ownerRepo })
      )
    )
    expect(mockApi.gh.issue).toHaveBeenCalledTimes(3)
    expect(Object.keys(store.getState().issueCache)).toHaveLength(3)
  })

  it('passes the captured repository to a paired runtime', async () => {
    const store = createTestStore()
    runtimeEnvironmentCall.mockResolvedValue({ id: 'issue', ok: true, result: null })
    await store.getState().fetchIssue('/repo', 247, {
      repoId: 'repo-1',
      ownerRepo: fork,
      sourceContext: githubSourceContext('runtime:env-1', 'repo-1')
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'github.issue',
        params: { repo: 'repo-1', number: 247, ownerRepo: fork }
      })
    )
  })

  it('does not display a response from an older runtime that ignores the repository', async () => {
    const store = createTestStore()
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'old-runtime',
      ok: true,
      result: {
        number: 247,
        title: 'Unrelated upstream issue',
        state: 'open',
        url: 'https://github.com/parent/repo/issues/247',
        labels: []
      }
    })
    await expect(
      store.getState().fetchIssue('/repo', 247, {
        repoId: 'repo-1',
        ownerRepo: fork,
        sourceContext: githubSourceContext('runtime:env-1', 'repo-1')
      })
    ).resolves.toBeNull()
  })
})
