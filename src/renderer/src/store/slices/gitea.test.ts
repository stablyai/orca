import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'

import { createGiteaSlice, type GiteaIssueScope } from './gitea'
import type { AppState } from '../types'
import type { GiteaConnectionStatus, GiteaIssue, GiteaWorkItem } from '../../../../shared/types'

const mockApi = {
  gitea: {
    status: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    selectServer: vi.fn(),
    testConnection: vi.fn(),
    listWorkItems: vi.fn(),
    issue: vi.fn(),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    addIssueComment: vi.fn()
  }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

function createTestStore() {
  return create<AppState>()((...a) => ({ ...createGiteaSlice(...a) }) as AppState)
}

function workItem(number: number, overrides: Partial<GiteaWorkItem> = {}): GiteaWorkItem {
  return {
    id: number,
    type: 'issue',
    number,
    repoOwner: 'acme',
    repoName: 'orca',
    title: `Item ${number}`,
    state: 'open',
    url: `https://gitea.example.com/acme/orca/issues/${number}`,
    labels: [],
    comments: 0,
    updatedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

function issue(number: number, overrides: Partial<GiteaIssue> = {}): GiteaIssue {
  return {
    id: number,
    number,
    repoOwner: 'acme',
    repoName: 'orca',
    title: `Issue ${number}`,
    state: 'open',
    url: `https://gitea.example.com/acme/orca/issues/${number}`,
    labels: [],
    assignees: [],
    comments: 0,
    updatedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

function connectedStatus(overrides: Partial<GiteaConnectionStatus> = {}): GiteaConnectionStatus {
  return { connected: true, activeServerId: 'srv-1', ...overrides }
}

const scope: GiteaIssueScope = { repoPath: '/repo', repoId: 'repo-1' }

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createGiteaSlice work item cache', () => {
  it('serves cached work items within the TTL without re-fetching', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const store = createTestStore()
    mockApi.gitea.listWorkItems.mockResolvedValue([workItem(1)])

    await store.getState().fetchGiteaWorkItems(scope, 'all')
    await store.getState().fetchGiteaWorkItems(scope, 'all')

    expect(mockApi.gitea.listWorkItems).toHaveBeenCalledTimes(1)
  })

  it('re-fetches once the cache TTL expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const store = createTestStore()
    mockApi.gitea.listWorkItems.mockResolvedValue([workItem(1)])

    await store.getState().fetchGiteaWorkItems(scope, 'all')
    vi.setSystemTime(1_000 + 60_001)
    await store.getState().fetchGiteaWorkItems(scope, 'all')

    expect(mockApi.gitea.listWorkItems).toHaveBeenCalledTimes(2)
  })

  it('keeps separate cache entries per filter', async () => {
    const store = createTestStore()
    mockApi.gitea.listWorkItems.mockResolvedValue([workItem(1)])

    await store.getState().fetchGiteaWorkItems(scope, 'all')
    await store.getState().fetchGiteaWorkItems(scope, 'assigned')

    expect(mockApi.gitea.listWorkItems).toHaveBeenCalledTimes(2)
    expect(mockApi.gitea.listWorkItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ repoPath: '/repo', repoId: 'repo-1', filter: 'assigned' })
    )
  })

  it('keys the cache by repoId so different repos do not collide', async () => {
    const store = createTestStore()
    mockApi.gitea.listWorkItems.mockResolvedValue([workItem(1)])

    await store.getState().fetchGiteaWorkItems({ repoPath: '/repo', repoId: 'repo-1' }, 'all')
    await store.getState().fetchGiteaWorkItems({ repoPath: '/repo', repoId: 'repo-2' }, 'all')

    expect(mockApi.gitea.listWorkItems).toHaveBeenCalledTimes(2)
  })
})

describe('createGiteaSlice issue detail cache', () => {
  it('caches issue detail by number within the TTL', async () => {
    const store = createTestStore()
    mockApi.gitea.issue.mockResolvedValue(issue(7))

    await store.getState().fetchGiteaIssue(scope, 7)
    await store.getState().fetchGiteaIssue(scope, 7)

    expect(mockApi.gitea.issue).toHaveBeenCalledTimes(1)
  })

  it('caches a null issue result so a missing issue is not refetched', async () => {
    const store = createTestStore()
    mockApi.gitea.issue.mockResolvedValue(null)

    await expect(store.getState().fetchGiteaIssue(scope, 9)).resolves.toBeNull()
    await expect(store.getState().fetchGiteaIssue(scope, 9)).resolves.toBeNull()

    expect(mockApi.gitea.issue).toHaveBeenCalledTimes(1)
  })
})

describe('createGiteaSlice createGiteaIssue', () => {
  it('returns the created issue and invalidates cached lists for the scope only', async () => {
    const store = createTestStore()
    mockApi.gitea.listWorkItems.mockResolvedValue([workItem(1)])
    const otherScope: GiteaIssueScope = { repoPath: '/other', repoId: 'repo-2' }

    await store.getState().fetchGiteaWorkItems(scope, 'all')
    await store.getState().fetchGiteaWorkItems(otherScope, 'all')
    expect(Object.keys(store.getState().giteaWorkItems)).toHaveLength(2)

    mockApi.gitea.createIssue.mockResolvedValue({
      ok: true,
      number: 42,
      url: 'https://gitea.example.com/acme/orca/issues/42'
    })

    await expect(store.getState().createGiteaIssue(scope, { title: 'New' })).resolves.toEqual({
      ok: true,
      number: 42,
      url: 'https://gitea.example.com/acme/orca/issues/42'
    })

    const keys = Object.keys(store.getState().giteaWorkItems)
    expect(keys).toEqual(['repo-2@selected:all:all:default'])
  })

  it('surfaces the error and preserves caches on failure', async () => {
    const store = createTestStore()
    mockApi.gitea.listWorkItems.mockResolvedValue([workItem(1)])
    await store.getState().fetchGiteaWorkItems(scope, 'all')

    mockApi.gitea.createIssue.mockResolvedValue({ ok: false, error: 'forbidden' })

    await expect(store.getState().createGiteaIssue(scope, { title: 'New' })).resolves.toEqual({
      ok: false,
      error: 'forbidden'
    })
    expect(Object.keys(store.getState().giteaWorkItems)).toHaveLength(1)
  })
})

describe('createGiteaSlice updateGiteaIssue', () => {
  it('invalidates the cached issue detail on success', async () => {
    const store = createTestStore()
    mockApi.gitea.issue.mockResolvedValue(issue(7))
    await store.getState().fetchGiteaIssue(scope, 7)
    expect(store.getState().giteaIssueDetail['repo-1@selected:all#7']).toBeDefined()

    mockApi.gitea.updateIssue.mockResolvedValue({ ok: true })
    await store.getState().updateGiteaIssue(scope, 7, { state: 'closed' })

    expect(store.getState().giteaIssueDetail['repo-1@selected:all#7']).toBeUndefined()
  })

  it('keeps the cached issue detail on failure', async () => {
    const store = createTestStore()
    mockApi.gitea.issue.mockResolvedValue(issue(7))
    await store.getState().fetchGiteaIssue(scope, 7)

    mockApi.gitea.updateIssue.mockResolvedValue({ ok: false, error: 'nope' })
    await store.getState().updateGiteaIssue(scope, 7, { state: 'closed' })

    expect(store.getState().giteaIssueDetail['repo-1@selected:all#7']).toBeDefined()
  })
})

describe('createGiteaSlice connection status', () => {
  it('stores status and marks it loaded on refresh', async () => {
    const store = createTestStore()
    mockApi.gitea.status.mockResolvedValue(connectedStatus())

    await store.getState().refreshGiteaStatus()

    expect(store.getState().giteaStatus).toEqual(connectedStatus())
    expect(store.getState().giteaStatusLoaded).toBe(true)
  })

  it('keeps the prior status but marks it loaded when the status read throws', async () => {
    const store = createTestStore()
    const prior = connectedStatus({ activeServerId: 'srv-prior' })
    store.setState({ giteaStatus: prior })
    mockApi.gitea.status.mockRejectedValue(new Error('offline'))

    await expect(store.getState().refreshGiteaStatus()).resolves.toEqual(prior)
    expect(store.getState().giteaStatus).toEqual(prior)
    expect(store.getState().giteaStatusLoaded).toBe(true)
  })

  it('refreshes status after a successful connect', async () => {
    const store = createTestStore()
    mockApi.gitea.connect.mockResolvedValue({ ok: true })
    mockApi.gitea.status.mockResolvedValue(connectedStatus())

    await expect(
      store.getState().giteaConnect({ baseUrl: 'https://gitea.example.com', token: 't' })
    ).resolves.toEqual({ ok: true })
    expect(mockApi.gitea.status).toHaveBeenCalledTimes(1)
  })

  it('returns the error and does not refresh on a failed connect', async () => {
    const store = createTestStore()
    mockApi.gitea.connect.mockResolvedValue({ ok: false, error: 'bad token' })

    await expect(
      store.getState().giteaConnect({ baseUrl: 'https://gitea.example.com', token: 't' })
    ).resolves.toEqual({ ok: false, error: 'bad token' })
    expect(mockApi.gitea.status).not.toHaveBeenCalled()
  })

  it('stores the status returned by selectServer', async () => {
    const store = createTestStore()
    const selected = connectedStatus({ selectedServerId: 'srv-2', activeServerId: 'srv-2' })
    mockApi.gitea.selectServer.mockResolvedValue(selected)

    await expect(store.getState().giteaSelectServer('srv-2')).resolves.toEqual(selected)
    expect(store.getState().giteaStatus).toEqual(selected)
    expect(store.getState().giteaStatusLoaded).toBe(true)
  })
})
