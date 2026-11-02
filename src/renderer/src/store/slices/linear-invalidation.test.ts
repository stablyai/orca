import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './linear-slice-test-harness'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearConnectionStatus, LinearTeam } from '../../../../shared/linear/workspace-types'

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
  isLinearIssueAttributeFilterUnsupportedError: () => false,
  linearListIssues: (...args: unknown[]) => linearListIssues(...args),
  linearSearchIssues: (...args: unknown[]) => linearSearchIssues(...args),
  linearSelectWorkspace: vi.fn(),
  linearStatus: (...args: unknown[]) => linearStatus(...args),
  linearTestConnection: vi.fn()
}))

vi.mock('@/runtime/runtime-linear-issue-mutations', () => ({
  linearGetIssue: (...args: unknown[]) => linearGetIssue(...args)
}))

vi.mock('@/runtime/runtime-linear-project-client', () => ({
  linearGetCustomView: vi.fn(),
  linearGetProject: vi.fn(),
  linearListCustomViewIssues: vi.fn(),
  linearListCustomViewProjects: vi.fn(),
  linearListCustomViews: vi.fn(),
  linearListProjectIssues: vi.fn(),
  linearListProjects: vi.fn(),
  linearListTeams: (...args: unknown[]) => linearListTeams(...args)
}))

vi.mock('../../hooks/useIssueMetadata', () => ({
  clearLinearMetadataCache: vi.fn()
}))

const viewer = {
  displayName: 'Ada',
  email: 'ada@example.com',
  organizationName: 'Alpha'
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
    vi.resetAllMocks()
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
    await expect(issuePromise).rejects.toThrow('Linear read abandoned')
    await teamPromise

    expect(store.getState().linearIssueCache).toEqual({})
    expect(store.getState().getCachedLinearTeams('workspace-1')).toBeNull()
  })

  it('forced status refresh detects workspace metadata changes with the same count', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: status('workspace-1', 'Old Org'),
      linearListCache: {
        'workspace-1::list::all::36::': {
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

    await expect(
      store.getState().listLinearIssues({ kind: 'list', filter: 'all', limit: 36 }, { force: true })
    ).rejects.toThrow('401 unauthorized')
    expect(store.getState().linearStatus.connected).toBe(true)
    await vi.waitFor(() => {
      expect(store.getState().linearStatus.workspaces?.map((workspace) => workspace.id)).toEqual([
        'workspace-2'
      ])
    })
  })
})
