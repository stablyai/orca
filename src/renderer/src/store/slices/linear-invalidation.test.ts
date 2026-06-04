import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { LinearConnectionStatus, LinearIssue, LinearTeam } from '../../../../shared/types'
import { createLinearSlice } from './linear'

const linearStatus = vi.fn()
const linearConnect = vi.fn()
const linearListIssues = vi.fn()
const linearSearchIssues = vi.fn()
const linearListTeams = vi.fn()
const linearGetIssue = vi.fn()

vi.mock('@/runtime/runtime-linear-client', () => ({
  linearConnect: (...args: unknown[]) => linearConnect(...args),
  linearDisconnect: vi.fn(),
  linearDisconnectWorkspace: vi.fn(),
  linearGetIssue: (...args: unknown[]) => linearGetIssue(...args),
  linearListIssues: (...args: unknown[]) => linearListIssues(...args),
  linearListTeams: (...args: unknown[]) => linearListTeams(...args),
  linearSearchIssues: (...args: unknown[]) => linearSearchIssues(...args),
  linearSelectWorkspace: vi.fn(),
  linearStatus: (...args: unknown[]) => linearStatus(...args),
  linearTestConnection: vi.fn()
}))

vi.mock('../../hooks/useIssueMetadata', () => ({
  clearLinearMetadataCache: vi.fn()
}))

const viewer = {
  displayName: 'Ada',
  email: 'ada@example.com',
  organizationName: 'Alpha'
}

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

function status(
  workspaceId: string,
  organizationName = 'Alpha',
  credentialRevision?: number
): LinearConnectionStatus {
  return {
    connected: true,
    viewer: { ...viewer, organizationName },
    selectedWorkspaceId: workspaceId,
    activeWorkspaceId: workspaceId,
    workspaces: [
      {
        id: workspaceId,
        organizationId: workspaceId,
        organizationName,
        displayName: viewer.displayName,
        email: viewer.email,
        credentialRevision
      }
    ]
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createLinearSlice invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps literal search queries separate from list cache keys', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearListCache: {
        'workspace-1::list::all::36': { data: { items: [issue('LIST')] }, fetchedAt: Date.now() }
      }
    })
    linearSearchIssues.mockResolvedValueOnce([issue('SEARCH')])

    await expect(store.getState().searchLinearIssues('list::all', 36)).resolves.toMatchObject([
      { id: 'SEARCH' }
    ])

    expect(
      store.getState().getCachedLinearIssues({ kind: 'search', query: 'list::all', limit: 36 })
    ).toMatchObject([{ id: 'SEARCH' }])
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).toMatchObject({ items: [{ id: 'LIST' }] })
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
      }
    })

    store.getState().patchLinearIssue('issue-id', { title: 'Updated' })

    expect(store.getState().linearIssueCache['workspace-1::issue-id'].data?.title).toBe('Updated')
    expect(store.getState().linearIssueCache['workspace-1::issue-id'].fetchedAt).toBe(0)
  })

  it('connect invalidates cached Linear rows and waits for refreshed status', async () => {
    const store = createTestStore()
    const statusRefresh = deferred<LinearConnectionStatus>()
    store.setState({
      linearIssueCache: {
        'workspace-1::issue-1': { data: issue('issue-1'), fetchedAt: Date.now() }
      },
      linearListCache: {
        'workspace-1::list::all::36': {
          data: { items: [issue('LIN-CACHED')] },
          fetchedAt: Date.now()
        }
      },
      linearTeamCache: {
        'workspace-1::teams': { data: [team('team-old')], fetchedAt: Date.now() }
      }
    })
    linearConnect.mockResolvedValueOnce({ ok: true, viewer })
    linearStatus.mockReturnValueOnce(statusRefresh.promise)

    let resolved = false
    const connectPromise = store
      .getState()
      .connectLinear('linear-key')
      .then((result) => {
        resolved = true
        return result
      })
    await Promise.resolve()

    expect(resolved).toBe(false)
    expect(store.getState().linearIssueCache).toEqual({})
    expect(store.getState().linearSearchCache).toEqual({})
    expect(store.getState().linearListCache).toEqual({})
    expect(store.getState().linearTeamCache).toEqual({})

    statusRefresh.resolve(status('workspace-1'))
    await expect(connectPromise).resolves.toEqual({ ok: true, viewer })
    expect(store.getState().linearStatus.selectedWorkspaceId).toBe('workspace-1')
  })

  it('drops stale in-flight issue and team cache writes after connect invalidation', async () => {
    const store = createTestStore()
    const staleIssue = deferred<LinearIssue | null>()
    const staleTeams = deferred<LinearTeam[]>()
    store.setState({
      linearStatus: { connected: true, viewer, selectedWorkspaceId: 'workspace-1' }
    })
    linearGetIssue.mockReturnValueOnce(staleIssue.promise)
    linearListTeams.mockReturnValueOnce(staleTeams.promise)
    linearConnect.mockResolvedValueOnce({ ok: true, viewer })
    linearStatus.mockResolvedValueOnce(status('workspace-1'))

    const issuePromise = store.getState().fetchLinearIssue('issue-1', 'workspace-1')
    const teamPromise = store.getState().listLinearTeams('workspace-1')
    await store.getState().connectLinear('linear-key')

    staleIssue.resolve(issue('issue-1'))
    staleTeams.resolve([team('team-stale')])
    await Promise.all([issuePromise, teamPromise])

    expect(store.getState().linearIssueCache).toEqual({})
    expect(store.getState().getCachedLinearTeams('workspace-1')).toBeNull()
  })

  it('forced status refresh detects workspace metadata changes with the same count', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: status('workspace-1', 'Old Org'),
      linearListCache: {
        'workspace-1::list::all::36': {
          data: { items: [issue('LIN-CACHED')] },
          fetchedAt: Date.now()
        }
      },
      linearTeamCache: {
        'workspace-1::teams': { data: [team('team-old')], fetchedAt: Date.now() }
      }
    })
    linearStatus.mockResolvedValueOnce(status('workspace-1', 'New Org', 2))

    await store.getState().checkLinearConnection(true)

    expect(store.getState().linearStatus.workspaces?.[0]?.organizationName).toBe('New Org')
    expect(store.getState().linearListCache).toEqual({})
    expect(store.getState().linearTeamCache).toEqual({})
  })

  it('refreshes status after an all-workspace auth failure without marking all Linear disconnected', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: {
        connected: true,
        viewer,
        selectedWorkspaceId: 'all',
        activeWorkspaceId: 'workspace-1',
        workspaces: [
          {
            id: 'workspace-1',
            organizationId: 'workspace-1',
            organizationName: 'Alpha',
            displayName: 'Ada',
            email: 'ada@example.com'
          },
          {
            id: 'workspace-2',
            organizationId: 'workspace-2',
            organizationName: 'Beta',
            displayName: 'Ada',
            email: 'ada@example.com'
          }
        ]
      }
    })
    linearListIssues.mockRejectedValueOnce(new Error('401 unauthorized'))
    linearStatus.mockResolvedValueOnce(status('workspace-2', 'Beta'))

    await expect(store.getState().listLinearIssues('all', 36, { force: true })).resolves.toEqual({
      items: []
    })
    expect(store.getState().linearStatus.connected).toBe(true)
    await vi.waitFor(() => {
      expect(store.getState().linearStatus.workspaces?.map((workspace) => workspace.id)).toEqual([
        'workspace-2'
      ])
    })
  })
})
