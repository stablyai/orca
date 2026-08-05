import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import { createGitHubSlice } from './github'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

const mockApi = {
  gh: {
    listWorkItems: vi.fn(),
    countWorkItems: vi.fn()
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
