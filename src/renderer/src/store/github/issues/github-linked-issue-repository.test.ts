import { beforeEach, describe, expect, it, vi } from 'vitest'
import { issueCacheKey } from '../cache/cache-identity'
import {
  createTestStore,
  githubSourceContext,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
} from '../github-slice-test-harness'

const fork = { owner: 'fork', repo: 'repo', host: 'github.com' }
const parent = { owner: 'parent', repo: 'repo', host: 'github.com' }
const issueFrom = (owner: string) => ({
  number: 247,
  title: `${owner} issue`,
  state: 'open',
  url: `https://github.com/${owner}/repo/issues/247`,
  labels: []
})

describe('linked issue cache and routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    // Number-only lookups resolve upstream-first in main.
    mockApi.gh.issue.mockImplementation(async (args: { ownerRepo?: { owner: string } }) =>
      issueFrom(args.ownerRepo?.owner ?? 'parent')
    )
  })

  it('refreshes a URL-linked fork issue into the key the workspace card reads', async () => {
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'repo',
          badgeColor: '',
          addedAt: 1,
          kind: 'git'
        }
      ],
      worktreeCardProperties: ['issue'],
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-1',
            isBare: true,
            linkedIssue: 247,
            linkedWorkItem: {
              provider: 'github',
              type: 'issue',
              number: 247,
              title: 'fork issue',
              url: 'https://github.com/fork/repo/issues/247'
            }
          })
        ]
      }
    })

    store.getState().refreshGitHubForWorktree('wt-1')
    const cardKey = issueCacheKey(
      '/repo',
      'repo-1',
      247,
      undefined,
      undefined,
      undefined,
      true,
      fork
    )
    await vi.waitFor(() =>
      expect(store.getState().issueCache[cardKey]?.data?.url).toBe(
        'https://github.com/fork/repo/issues/247'
      )
    )
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

  it('forwards the saved repository to runtimes and keeps their answer', async () => {
    const store = createTestStore()
    // Older runtimes drop ownerRepo; newer ones may answer with a renamed repository's URL.
    runtimeEnvironmentCall.mockResolvedValue({ id: 'issue', ok: true, result: issueFrom('parent') })
    const issue = await store.getState().fetchIssue('/repo', 247, {
      repoId: 'repo-1',
      ownerRepo: fork,
      sourceContext: githubSourceContext('runtime:env-1', 'repo-1')
    })
    expect(issue?.url).toBe('https://github.com/parent/repo/issues/247')
    expect(runtimeEnvironmentTransportCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'github.issue',
        params: { repo: 'repo-1', number: 247, ownerRepo: fork }
      })
    )
  })
})
