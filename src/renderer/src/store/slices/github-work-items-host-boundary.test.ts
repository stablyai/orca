import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import { createGitHubSlice, workItemsCacheKey } from './github'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { error: toastError }
}))

const mockApi = {
  gh: {
    listWorkItems: vi.fn(),
    countWorkItems: vi.fn()
  },
  repos: {
    update: vi.fn()
  }
}

globalThis.window = { api: mockApi } as never

function createTestStore() {
  return create<AppState>()((...args) => createGitHubSlice(...args) as AppState)
}

function duplicateRepos(): AppState['repos'] {
  return [
    {
      id: 'repo-1',
      path: '/shared/repo',
      displayName: 'local duplicate',
      badgeColor: 'blue',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'repo-1',
      path: '/shared/repo',
      displayName: 'SSH owner',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1'
    }
  ]
}

function sshSourceContext(): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'github',
    projectId: 'github:stablyai/orca',
    hostId: 'ssh:ssh-1',
    projectHostSetupId: 'setup-1',
    repoId: 'repo-1',
    providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
  }
}

describe('GitHub work-item host boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.gh.listWorkItems.mockResolvedValue({
      items: [],
      sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    })
    mockApi.gh.countWorkItems.mockResolvedValue(7)
    mockApi.repos.update.mockResolvedValue(undefined)
  })

  it('preserves an explicit SSH source owner through local list IPC', async () => {
    const store = createTestStore()
    store.setState({ repos: duplicateRepos() } as Partial<AppState>)
    const sourceContext = sshSourceContext()

    await store.getState().fetchWorkItems('repo-1', '/shared/repo', 24, '', { sourceContext })

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/shared/repo',
      repoId: 'repo-1',
      sourceContext,
      limit: 24,
      query: undefined
    })
  })

  it('preserves an explicit repo host through initial fetch and prefetch IPC', async () => {
    const store = createTestStore()
    store.setState({ repos: duplicateRepos() } as Partial<AppState>)
    const owner = {
      repoId: 'repo-1',
      path: '/shared/repo',
      executionHostId: 'ssh:ssh-1'
    }

    await store.getState().fetchWorkItemsAcrossRepos([owner], 24, 100, '')

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/shared/repo',
      repoId: 'repo-1',
      executionHostId: 'ssh:ssh-1',
      limit: 24,
      query: undefined
    })

    await store.getState().fetchWorkItems('repo-1', '/shared/repo', 24, 'is:open', {
      executionHostId: 'local'
    })
    mockApi.gh.listWorkItems.mockClear()
    store.getState().prefetchWorkItems('repo-1', '/shared/repo', 24, 'is:open', {
      executionHostId: 'ssh:ssh-1'
    })

    await vi.waitFor(() =>
      expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
        repoPath: '/shared/repo',
        repoId: 'repo-1',
        executionHostId: 'ssh:ssh-1',
        limit: 24,
        query: 'is:open'
      })
    )
  })

  it('keeps stale-cache fallback scoped to the requested repo host', async () => {
    const store = createTestStore()
    store.setState({ repos: duplicateRepos() } as Partial<AppState>)
    const sources = { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    const localItem = {
      type: 'issue' as const,
      number: 1,
      title: 'Local item',
      url: 'https://example.test/local',
      updatedAt: '2026-08-05T00:00:00Z'
    }
    const sshItem = {
      type: 'issue' as const,
      number: 2,
      title: 'SSH item',
      url: 'https://example.test/ssh',
      updatedAt: '2026-08-05T00:00:00Z'
    }
    mockApi.gh.listWorkItems
      .mockResolvedValueOnce({ items: [localItem], sources })
      .mockResolvedValueOnce({ items: [sshItem], sources })
      .mockRejectedValueOnce(new Error('refresh failed'))

    await store.getState().fetchWorkItems('repo-1', '/shared/repo', 24, '', {
      executionHostId: 'local'
    })
    await store.getState().fetchWorkItems('repo-1', '/shared/repo', 24, '', {
      executionHostId: 'ssh:ssh-1'
    })
    const result = await store
      .getState()
      .fetchWorkItemsAcrossRepos(
        [{ repoId: 'repo-1', path: '/shared/repo', executionHostId: 'ssh:ssh-1' }],
        24,
        100,
        '',
        { force: true }
      )

    expect(result.items).toEqual([
      { ...sshItem, repoId: 'repo-1', repoExecutionHostId: 'ssh:ssh-1' }
    ])
    expect(result.failedCount).toBe(0)
  })

  it('persists issue-source preference to only the requested repo host', async () => {
    const store = createTestStore()
    const [localRepo, sshRepo] = duplicateRepos()
    store.setState({
      repos: [
        { ...localRepo, issueSourcePreference: 'origin' },
        { ...sshRepo, issueSourcePreference: 'origin' }
      ]
    } as Partial<AppState>)

    await store.getState().setIssueSourcePreference('repo-1', '/shared/repo', 'upstream', {
      executionHostId: 'ssh:ssh-1'
    })

    expect(store.getState().repos.map((repo) => repo.issueSourcePreference)).toEqual([
      'origin',
      'upstream'
    ])
    expect(mockApi.repos.update).toHaveBeenCalledWith({
      repoId: 'repo-1',
      hostId: 'ssh:ssh-1',
      updates: { issueSourcePreference: 'upstream' }
    })
  })

  it('reports an unresolved issue-source preference owner', async () => {
    const store = createTestStore()
    store.setState({ repos: duplicateRepos() } as Partial<AppState>)

    await store.getState().setIssueSourcePreference('repo-1', '/shared/repo', 'upstream', {
      executionHostId: 'ssh:missing'
    })

    expect(toastError).toHaveBeenCalledWith('Failed to save issue-source preference', {
      duration: 60_000
    })
    expect(mockApi.repos.update).not.toHaveBeenCalled()
  })

  it('evicts host-scoped work-item cache entries when issue-source preference changes', async () => {
    const store = createTestStore()
    const hostScopedKey = workItemsCacheKey('repo-1', 24, '', 'ssh:ssh-1')
    const unrelatedKey = workItemsCacheKey('repo-2', 24, '', 'ssh:ssh-1')
    store.setState({
      repos: duplicateRepos(),
      workItemsInvalidationNonce: 4,
      workItemsCache: {
        [hostScopedKey]: { data: [], fetchedAt: 1 },
        [unrelatedKey]: { data: [], fetchedAt: 1 }
      }
    } as Partial<AppState>)

    await store.getState().setIssueSourcePreference('repo-1', '/shared/repo', 'upstream', {
      executionHostId: 'ssh:ssh-1'
    })

    expect(Object.keys(store.getState().workItemsCache)).toEqual([unrelatedKey])
    expect(store.getState().workItemsInvalidationNonce).toBe(5)
  })

  it('preserves an explicit repo host through pagination and count IPC', async () => {
    const store = createTestStore()
    store.setState({ repos: duplicateRepos() } as Partial<AppState>)
    const owner = {
      repoId: 'repo-1',
      path: '/shared/repo',
      executionHostId: 'ssh:ssh-1'
    }

    await store.getState().fetchWorkItemsNextPage([owner], 24, 100, '', 2)
    await expect(store.getState().countWorkItemsAcrossRepos([owner], '', 24)).resolves.toEqual({
      totalCount: 7,
      totalPages: 1
    })

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/shared/repo',
      repoId: 'repo-1',
      executionHostId: 'ssh:ssh-1',
      limit: 24,
      query: undefined,
      page: 2
    })
    expect(mockApi.gh.countWorkItems).toHaveBeenCalledWith({
      repoPath: '/shared/repo',
      repoId: 'repo-1',
      executionHostId: 'ssh:ssh-1',
      query: undefined
    })
  })
})
