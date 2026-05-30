/* eslint-disable max-lines -- Why: Linear cache and fallback tests share one
   mocked slice harness, keeping failure-mode coverage easy to compare. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type {
  LinearConnectionStatus,
  LinearIssue,
  LinearProjectDetail,
  LinearProjectSummary,
  LinearTeam,
  LinearViewer
} from '../../../../shared/types'
import { createLinearSlice } from './linear'

const linearStatus = vi.fn()
const linearConnect = vi.fn()
const linearDisconnect = vi.fn()
const linearListIssues = vi.fn()
const linearSearchIssues = vi.fn()
const linearListTeams = vi.fn()
const linearGetIssue = vi.fn()
const linearListProjects = vi.fn()
const linearGetCustomView = vi.fn()
const linearGetProject = vi.fn()
const linearListProjectIssues = vi.fn()
const linearListCustomViews = vi.fn()
const linearListCustomViewIssues = vi.fn()
const linearListCustomViewProjects = vi.fn()
const linearTestConnection = vi.fn()

vi.mock('@/runtime/runtime-linear-client', () => ({
  linearConnect: (...args: unknown[]) => linearConnect(...args),
  linearDisconnect: (...args: unknown[]) => linearDisconnect(...args),
  linearDisconnectWorkspace: vi.fn(),
  linearGetCustomView: (...args: unknown[]) => linearGetCustomView(...args),
  linearGetProject: (...args: unknown[]) => linearGetProject(...args),
  linearGetIssue: (...args: unknown[]) => linearGetIssue(...args),
  linearListCustomViewIssues: (...args: unknown[]) => linearListCustomViewIssues(...args),
  linearListCustomViewProjects: (...args: unknown[]) => linearListCustomViewProjects(...args),
  linearListCustomViews: (...args: unknown[]) => linearListCustomViews(...args),
  linearListIssues: (...args: unknown[]) => linearListIssues(...args),
  linearListProjectIssues: (...args: unknown[]) => linearListProjectIssues(...args),
  linearListProjects: (...args: unknown[]) => linearListProjects(...args),
  linearListTeams: (...args: unknown[]) => linearListTeams(...args),
  linearSearchIssues: (...args: unknown[]) => linearSearchIssues(...args),
  linearSelectWorkspace: vi.fn(),
  linearStatus: (...args: unknown[]) => linearStatus(...args),
  linearTestConnection: (...args: unknown[]) => linearTestConnection(...args)
}))

vi.mock('../../hooks/useIssueMetadata', () => ({
  clearLinearMetadataCache: vi.fn()
}))

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        settings: null,
        ...createLinearSlice(...a)
      }) as AppState
  )
}

function issue(id: string): LinearIssue {
  return {
    id,
    identifier: id,
    title: id,
    url: `https://linear.app/${id}`,
    state: { name: 'Todo', type: 'unstarted', color: '#888888' },
    team: { id: 'team-1', name: 'Team', key: 'TM' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function team(id: string): LinearTeam {
  return { id, name: id, key: id, workspaceId: 'workspace-1', workspaceName: 'Workspace' }
}

function project(id: string): LinearProjectSummary {
  return { id, name: id, workspaceId: 'workspace-1', workspaceName: 'Workspace' }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createLinearSlice caching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('serves fresh list cache and lets forced refresh bypass it', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' }
    })
    linearListIssues.mockResolvedValueOnce([issue('LIN-1')]).mockResolvedValueOnce([issue('LIN-2')])

    await expect(store.getState().listLinearIssues('all', 36)).resolves.toMatchObject([
      { id: 'LIN-1' }
    ])
    await expect(store.getState().listLinearIssues('all', 36)).resolves.toMatchObject([
      { id: 'LIN-1' }
    ])
    await expect(
      store.getState().listLinearIssues('all', 36, { force: true })
    ).resolves.toMatchObject([{ id: 'LIN-2' }])

    expect(linearListIssues).toHaveBeenCalledTimes(2)
  })

  it('lets forced list refresh bypass older in-flight reads without stale cache overwrite', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' }
    })
    const staleRequest = deferred<LinearIssue[]>()
    const forcedRequest = deferred<LinearIssue[]>()
    linearListIssues
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(forcedRequest.promise)

    const stalePromise = store.getState().listLinearIssues('all', 36)
    const forcedPromise = store.getState().listLinearIssues('all', 36, { force: true })

    expect(linearListIssues).toHaveBeenCalledTimes(2)

    forcedRequest.resolve([issue('LIN-FORCED')])
    await expect(forcedPromise).resolves.toMatchObject([{ id: 'LIN-FORCED' }])
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).toMatchObject([{ id: 'LIN-FORCED' }])

    staleRequest.resolve([issue('LIN-STALE')])
    await expect(stalePromise).resolves.toMatchObject([{ id: 'LIN-STALE' }])
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).toMatchObject([{ id: 'LIN-FORCED' }])
  })

  it('lets forced search refresh bypass older in-flight reads without stale cache overwrite', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' }
    })
    const staleRequest = deferred<LinearIssue[]>()
    const forcedRequest = deferred<LinearIssue[]>()
    linearSearchIssues
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(forcedRequest.promise)

    const stalePromise = store.getState().searchLinearIssues('loading', 36)
    const forcedPromise = store.getState().searchLinearIssues('loading', 36, { force: true })

    expect(linearSearchIssues).toHaveBeenCalledTimes(2)

    forcedRequest.resolve([issue('LIN-FORCED')])
    await expect(forcedPromise).resolves.toMatchObject([{ id: 'LIN-FORCED' }])
    expect(
      store.getState().getCachedLinearIssues({ kind: 'search', query: 'loading', limit: 36 })
    ).toMatchObject([{ id: 'LIN-FORCED' }])

    staleRequest.resolve([issue('LIN-STALE')])
    await expect(stalePromise).resolves.toMatchObject([{ id: 'LIN-STALE' }])
    expect(
      store.getState().getCachedLinearIssues({ kind: 'search', query: 'loading', limit: 36 })
    ).toMatchObject([{ id: 'LIN-FORCED' }])
  })

  it('preserves cached list rows when forced revalidation fails transiently', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearSearchCache: {
        'workspace-1::list::all::36': { data: [issue('LIN-CACHED')], fetchedAt: 1 }
      }
    })
    linearListIssues.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().listLinearIssues('all', 36, { force: true })
    ).resolves.toMatchObject([{ id: 'LIN-CACHED' }])
  })

  it('surfaces scoped project issue failures alongside cached rows', async () => {
    const store = createTestStore()
    store.setState({
      linearProjectIssueCache: {
        'workspace-1::project-issues::project-1::20': {
          data: { items: [issue('LIN-CACHED')] },
          fetchedAt: 1
        }
      }
    })
    linearListProjectIssues.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().listLinearProjectIssues('project-1', 'workspace-1', 20, { force: true })
    ).resolves.toMatchObject({
      items: [{ id: 'LIN-CACHED' }],
      errors: [{ workspaceId: 'workspace-1', type: 'unknown', message: 'network down' }]
    })
  })

  it('surfaces scoped custom-view project failures alongside cached rows', async () => {
    const store = createTestStore()
    const rateLimitError = Object.assign(new Error('slow down'), { status: 429 })
    store.setState({
      linearCustomViewProjectCache: {
        'workspace-1::custom-view-projects::view-1::20': {
          data: { items: [project('project-cached')] },
          fetchedAt: 1
        }
      }
    })
    linearListCustomViewProjects.mockRejectedValueOnce(rateLimitError)

    await expect(
      store.getState().listLinearCustomViewProjects('view-1', 'workspace-1', 20, {
        force: true
      })
    ).resolves.toMatchObject({
      items: [{ id: 'project-cached' }],
      errors: [{ workspaceId: 'workspace-1', type: 'rate_limited', message: 'slow down' }]
    })
  })

  it('surfaces top-level project list failures alongside cached rows', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearProjectCache: {
        'workspace-1::projects::::20': {
          data: { items: [project('project-cached')] },
          fetchedAt: 1
        }
      }
    })
    linearListProjects.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().listLinearProjects(undefined, 20, undefined, { force: true })
    ).resolves.toMatchObject({
      items: [{ id: 'project-cached' }],
      errors: [{ workspaceId: 'workspace-1', type: 'unknown', message: 'network down' }]
    })
  })

  it('surfaces top-level custom-view failures alongside cached rows', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearCustomViewCache: {
        'workspace-1::custom-views::project::20': {
          data: {
            items: [{ id: 'view-cached', name: 'Cached view', model: 'project' }]
          },
          fetchedAt: 1
        }
      }
    })
    linearListCustomViews.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().listLinearCustomViews('project', 20, undefined, { force: true })
    ).resolves.toMatchObject({
      items: [{ id: 'view-cached' }],
      errors: [{ workspaceId: 'workspace-1', type: 'unknown', message: 'network down' }]
    })
  })

  it('fetches custom views by exact id for saved-context restore', async () => {
    const store = createTestStore()
    linearGetCustomView.mockResolvedValueOnce({
      id: 'view-1',
      name: 'Burn views',
      model: 'project',
      workspaceId: 'workspace-1'
    })

    await expect(
      store.getState().fetchLinearCustomView('view-1', 'workspace-1', 'project', { force: true })
    ).resolves.toMatchObject({ id: 'view-1' })

    expect(linearGetCustomView).toHaveBeenCalledWith(null, 'view-1', 'project', 'workspace-1')
  })

  it('fails forced exact custom-view validation instead of reopening stale cache', async () => {
    const store = createTestStore()
    store.setState({
      linearCustomViewDetailCache: {
        'workspace-1::custom-view-detail::project::view-1': {
          data: {
            id: 'view-1',
            name: 'Stale view',
            model: 'project',
            workspaceId: 'workspace-1'
          },
          fetchedAt: 1
        }
      }
    })
    linearGetCustomView.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().fetchLinearCustomView('view-1', 'workspace-1', 'project', { force: true })
    ).rejects.toThrow('network down')
  })

  it('prevents stale detail reads from overwriting forced refresh caches', async () => {
    const store = createTestStore()
    const staleProject = deferred<LinearProjectDetail | null>()
    const freshProject = deferred<LinearProjectDetail | null>()
    const staleView = deferred<{
      id: string
      name: string
      model: 'project'
      workspaceId: string
    }>()
    const freshView = deferred<{
      id: string
      name: string
      model: 'project'
      workspaceId: string
    }>()
    linearGetProject
      .mockReturnValueOnce(staleProject.promise)
      .mockReturnValueOnce(freshProject.promise)
    linearGetCustomView
      .mockReturnValueOnce(staleView.promise)
      .mockReturnValueOnce(freshView.promise)

    const staleProjectPromise = store.getState().fetchLinearProject('project-1', 'workspace-1')
    const freshProjectPromise = store
      .getState()
      .fetchLinearProject('project-1', 'workspace-1', { force: true })
    const staleViewPromise = store
      .getState()
      .fetchLinearCustomView('view-1', 'workspace-1', 'project')
    const freshViewPromise = store
      .getState()
      .fetchLinearCustomView('view-1', 'workspace-1', 'project', { force: true })

    freshProject.resolve({ ...project('project-1'), name: 'Fresh project' })
    freshView.resolve({
      id: 'view-1',
      name: 'Fresh view',
      model: 'project',
      workspaceId: 'workspace-1'
    })
    await freshProjectPromise
    await freshViewPromise

    staleProject.resolve({ ...project('project-1'), name: 'Stale project' })
    staleView.resolve({
      id: 'view-1',
      name: 'Stale view',
      model: 'project',
      workspaceId: 'workspace-1'
    })
    await staleProjectPromise
    await staleViewPromise

    expect(
      store.getState().linearProjectDetailCache['workspace-1::project-detail::project-1'].data?.name
    ).toBe('Fresh project')
    expect(
      store.getState().linearCustomViewDetailCache[
        'workspace-1::custom-view-detail::project::view-1'
      ].data?.name
    ).toBe('Fresh view')
  })

  it('preserves cached search rows when forced revalidation fails transiently', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearSearchCache: {
        'workspace-1::search::loading::36': { data: [issue('LIN-CACHED')], fetchedAt: 1 }
      }
    })
    linearSearchIssues.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().searchLinearIssues('loading', 36, { force: true })
    ).resolves.toMatchObject([{ id: 'LIN-CACHED' }])
  })

  it('returns stale cached rows for immediate rendering while revalidation decides freshness', () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearSearchCache: {
        'workspace-1::list::all::36': { data: [issue('LIN-1')], fetchedAt: 1 }
      }
    })

    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).toEqual([issue('LIN-1')])
  })

  it('keeps literal search queries separate from list cache keys', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearSearchCache: {
        'workspace-1::list::all::36': { data: [issue('LIST')], fetchedAt: Date.now() }
      }
    })
    linearSearchIssues.mockResolvedValueOnce([issue('SEARCH')])

    await expect(store.getState().searchLinearIssues('list::all', 36)).resolves.toMatchObject([
      { id: 'SEARCH' }
    ])

    expect(linearSearchIssues).toHaveBeenCalledTimes(1)
    expect(
      store.getState().getCachedLinearIssues({ kind: 'search', query: 'list::all', limit: 36 })
    ).toMatchObject([{ id: 'SEARCH' }])
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).toMatchObject([{ id: 'LIST' }])
  })

  it('caches teams by workspace and dedupes fresh reads', async () => {
    const store = createTestStore()
    linearListTeams.mockResolvedValueOnce([team('team-1')])

    await expect(store.getState().listLinearTeams('workspace-1')).resolves.toMatchObject([
      { id: 'team-1' }
    ])
    await expect(store.getState().listLinearTeams('workspace-1')).resolves.toMatchObject([
      { id: 'team-1' }
    ])

    expect(linearListTeams).toHaveBeenCalledTimes(1)
    expect(store.getState().getCachedLinearTeams('workspace-1')).toMatchObject([{ id: 'team-1' }])
  })

  it('patches issue-cache entries keyed by workspace-qualified ids', () => {
    const store = createTestStore()
    store.setState({
      linearIssueCache: {
        'workspace-1::issue-id': { data: issue('issue-id'), fetchedAt: Date.now() }
      },
      linearProjectIssueCache: {
        'workspace-1::project-issues::project-1::20': {
          data: { items: [issue('issue-id')] },
          fetchedAt: Date.now()
        }
      },
      linearCustomViewIssueCache: {
        'workspace-1::custom-view-issues::view-1::20': {
          data: { items: [issue('issue-id')] },
          fetchedAt: Date.now()
        }
      }
    })

    store.getState().patchLinearIssue('issue-id', { title: 'Updated' })

    expect(store.getState().linearIssueCache['workspace-1::issue-id'].data?.title).toBe('Updated')
    expect(store.getState().linearIssueCache['workspace-1::issue-id'].fetchedAt).toBe(0)
    expect(
      store.getState().linearProjectIssueCache['workspace-1::project-issues::project-1::20'].data
        ?.items[0]?.title
    ).toBe('Updated')
    expect(
      store.getState().linearCustomViewIssueCache['workspace-1::custom-view-issues::view-1::20']
        .data?.items[0]?.title
    ).toBe('Updated')
  })
})

describe('createLinearSlice', () => {
  beforeEach(() => {
    linearStatus.mockReset()
    linearConnect.mockReset()
    linearDisconnect.mockReset()
    linearListIssues.mockReset()
    linearSearchIssues.mockReset()
    linearListTeams.mockReset()
    linearGetIssue.mockReset()
    linearTestConnection.mockReset()
  })

  it('dedupes concurrent connection checks', async () => {
    const pending = deferred<LinearConnectionStatus>()
    linearStatus.mockReturnValueOnce(pending.promise)
    const store = createTestStore()

    const first = store.getState().checkLinearConnection()
    const second = store.getState().checkLinearConnection()

    expect(linearStatus).toHaveBeenCalledTimes(1)
    pending.resolve({
      connected: true,
      viewer: {
        displayName: 'Test User',
        email: 'test@example.com',
        organizationName: 'Test Org'
      }
    })
    await Promise.all([first, second])

    expect(store.getState().linearStatus.connected).toBe(true)
    expect(store.getState().linearStatusChecked).toBe(true)
  })

  it('ignores stale forced connection checks when a newer forced check finishes first', async () => {
    const staleCheck = deferred<LinearConnectionStatus>()
    const freshCheck = deferred<LinearConnectionStatus>()
    const viewer = {
      displayName: 'Test User',
      email: 'test@example.com',
      organizationName: 'Test Org'
    }
    linearStatus.mockReturnValueOnce(staleCheck.promise).mockReturnValueOnce(freshCheck.promise)
    const store = createTestStore()

    const stalePromise = store.getState().checkLinearConnection(true)
    const freshPromise = store.getState().checkLinearConnection(true)

    freshCheck.resolve({ connected: true, viewer })
    await freshPromise
    staleCheck.resolve({ connected: false, viewer: null })
    await stalePromise

    expect(store.getState().linearStatus.connected).toBe(true)
    expect(store.getState().linearStatus.viewer?.email).toBe('test@example.com')
  })

  it('ignores stale status checks after a successful connect', async () => {
    const staleMountCheck = deferred<LinearConnectionStatus>()
    const freshConnectCheck = deferred<LinearConnectionStatus>()
    const viewer = {
      displayName: 'Test User',
      email: 'test@example.com',
      organizationName: 'Test Org'
    }
    linearStatus
      .mockReturnValueOnce(staleMountCheck.promise)
      .mockReturnValueOnce(freshConnectCheck.promise)
    linearConnect.mockResolvedValueOnce({ ok: true, viewer })
    const store = createTestStore()

    const mountCheck = store.getState().checkLinearConnection()
    const connectPromise = store.getState().connectLinear('linear-key')
    await Promise.resolve()

    expect(linearStatus).toHaveBeenCalledTimes(2)

    freshConnectCheck.resolve({ connected: true, viewer })
    await connectPromise

    staleMountCheck.resolve({ connected: false, viewer: null })
    await mountCheck

    expect(store.getState().linearStatus.connected).toBe(true)
    expect(store.getState().linearStatus.viewer?.email).toBe('test@example.com')
  })

  it('does not let a background status refresh cancel an in-flight connect', async () => {
    const connectResult = deferred<{ ok: true; viewer: LinearViewer }>()
    const backgroundStatus = deferred<LinearConnectionStatus>()
    const connectStatus = deferred<LinearConnectionStatus>()
    const viewer = {
      displayName: 'Test User',
      email: 'test@example.com',
      organizationName: 'Test Org'
    }
    linearConnect.mockReturnValueOnce(connectResult.promise)
    linearStatus
      .mockReturnValueOnce(backgroundStatus.promise)
      .mockReturnValueOnce(connectStatus.promise)
    const store = createTestStore()

    const connectPromise = store.getState().connectLinear('linear-key')
    const refreshPromise = store.getState().checkLinearConnection(true)

    backgroundStatus.resolve({ connected: false, viewer: null })
    await refreshPromise

    connectResult.resolve({ ok: true, viewer })
    await Promise.resolve()
    expect(linearStatus).toHaveBeenCalledTimes(2)

    connectStatus.resolve({ connected: true, viewer })
    await connectPromise

    expect(store.getState().linearStatus.connected).toBe(true)
    expect(store.getState().linearStatus.viewer?.email).toBe('test@example.com')
  })

  it('ignores stale direct status writes after a newer mutation', async () => {
    const testResult = deferred<{ ok: true; viewer: LinearViewer }>()
    const staleStatus = deferred<LinearConnectionStatus>()
    const viewer = {
      displayName: 'Test User',
      email: 'test@example.com',
      organizationName: 'Test Org'
    }
    linearTestConnection.mockReturnValueOnce(testResult.promise)
    linearStatus.mockReturnValueOnce(staleStatus.promise)
    linearDisconnect.mockResolvedValueOnce(undefined)
    const store = createTestStore()

    const testPromise = store.getState().testLinearConnection()
    testResult.resolve({ ok: true, viewer })
    await Promise.resolve()

    await store.getState().disconnectLinear()
    staleStatus.resolve({ connected: true, viewer })
    await testPromise

    expect(store.getState().linearStatus.connected).toBe(false)
    expect(store.getState().linearStatus.viewer).toBeNull()
  })
})
