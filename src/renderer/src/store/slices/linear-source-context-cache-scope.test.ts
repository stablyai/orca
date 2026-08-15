import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearCollectionResult, LinearTeam } from '../../../../shared/linear/workspace-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { createTestStore, deferred, issue, project } from './linear-slice-test-harness'

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

vi.mock('@/runtime/runtime-linear-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
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
  }
})

vi.mock('../../hooks/useIssueMetadata', () => ({
  clearLinearMetadataCache: vi.fn()
}))

function team(id: string): LinearTeam {
  return { id, name: id, key: id, workspaceId: 'workspace-1', workspaceName: 'Workspace' }
}

function linearSourceContext(
  environmentId: string,
  workspaceId = 'workspace-1'
): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'linear',
    projectId: 'logical-project',
    hostId: `runtime:${environmentId}`,
    providerIdentity: {
      provider: 'linear',
      workspaceId
    }
  }
}

describe('createLinearSlice caching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('routes explicit source reads through their source context when focused runtime changes', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' }
    })
    const sourceContext = linearSourceContext('source-runtime')
    const sourceResult = deferred<LinearCollectionResult<LinearIssue>>()
    linearListIssues.mockReturnValueOnce(sourceResult.promise)

    const request = store
      .getState()
      .listLinearIssues({ kind: 'list', filter: 'all', limit: 36 }, { sourceContext })
    store.setState({ settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as never })

    sourceResult.resolve({ items: [issue('LIN-SOURCE')] })
    await expect(request).resolves.toMatchObject({ items: [{ id: 'LIN-SOURCE' }] })
    expect(linearListIssues).toHaveBeenCalledWith(
      sourceContext,
      'all',
      36,
      'workspace-1',
      undefined
    )
    expect(
      store
        .getState()
        .getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 }, { sourceContext })
    ).toMatchObject({ items: [{ id: 'LIN-SOURCE' }] })
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'all', limit: 36 })
    ).toBeNull()
  })

  it('scopes cached Linear teams, projects, and views to the explicit source context', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' }
    })
    const localSource = linearSourceContext('local-runtime')
    const remoteSource = linearSourceContext('remote-runtime')
    const localScope = getTaskSourceCacheScope(localSource)
    const remoteScope = getTaskSourceCacheScope(remoteSource)
    const fetchedAt = Date.now()

    store.setState({
      linearTeamCache: {
        [`${localScope}::workspace-1::teams`]: { data: [team('local-team')], fetchedAt },
        [`${remoteScope}::workspace-1::teams`]: { data: [team('remote-team')], fetchedAt }
      },
      linearProjectCache: {
        [`${localScope}::workspace-1::projects::::20`]: {
          data: { items: [project('local-project')] },
          fetchedAt
        },
        [`${remoteScope}::workspace-1::projects::::20`]: {
          data: { items: [project('remote-project')] },
          fetchedAt
        }
      },
      linearCustomViewCache: {
        [`${localScope}::workspace-1::custom-views::issue::20`]: {
          data: { items: [{ id: 'local-view', name: 'Local view', model: 'issue' }] },
          fetchedAt
        },
        [`${remoteScope}::workspace-1::custom-views::issue::20`]: {
          data: { items: [{ id: 'remote-view', name: 'Remote view', model: 'issue' }] },
          fetchedAt
        }
      }
    })

    expect(
      store.getState().getCachedLinearTeams('workspace-1', { sourceContext: remoteSource })
    ).toMatchObject([{ id: 'remote-team' }])
    expect(
      store
        .getState()
        .getCachedLinearProjects(undefined, 20, 'workspace-1', { sourceContext: remoteSource })
    ).toMatchObject({ items: [{ id: 'remote-project' }] })
    expect(
      store
        .getState()
        .getCachedLinearCustomViews('issue', 20, 'workspace-1', { sourceContext: remoteSource })
    ).toMatchObject({ items: [{ id: 'remote-view' }] })
    expect(store.getState().getCachedLinearTeams('workspace-1')).toBeNull()
    expect(store.getState().getCachedLinearProjects(undefined, 20, 'workspace-1')).toBeNull()
    expect(store.getState().getCachedLinearCustomViews('issue', 20, 'workspace-1')).toBeNull()
  })

  it('patches issue-cache entries keyed by workspace-qualified ids', () => {
    const store = createTestStore()
    store.setState({
      linearIssueCache: {
        'workspace-1::issue-id': { data: issue('issue-id'), fetchedAt: Date.now() }
      },
      linearListCache: {
        'workspace-1::list::all::36::': {
          data: { items: [issue('issue-id')] },
          fetchedAt: Date.now()
        }
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
      store.getState().linearListCache['workspace-1::list::all::36::'].data?.items[0]?.title
    ).toBe('Updated')
    expect(
      store.getState().linearProjectIssueCache['workspace-1::project-issues::project-1::20'].data
        ?.items[0]?.title
    ).toBe('Updated')
    expect(
      store.getState().linearCustomViewIssueCache['workspace-1::custom-view-issues::view-1::20']
        .data?.items[0]?.title
    ).toBe('Updated')
  })

  it('scopes optimistic issue patches to the selected Linear source context', () => {
    const store = createTestStore()
    const localSource = linearSourceContext('local-runtime')
    const remoteSource = linearSourceContext('remote-runtime')
    const localScope = getTaskSourceCacheScope(localSource)
    const remoteScope = getTaskSourceCacheScope(remoteSource)

    store.setState({
      linearIssueCache: {
        [`${localScope}::workspace-1::issue-id`]: {
          data: { ...issue('issue-id'), title: 'Local title' },
          fetchedAt: Date.now()
        },
        [`${remoteScope}::workspace-1::issue-id`]: {
          data: { ...issue('issue-id'), title: 'Remote title' },
          fetchedAt: Date.now()
        }
      },
      linearSearchCache: {
        [`${localScope}::workspace-1::search::query::20`]: {
          data: [{ ...issue('issue-id'), title: 'Local title' }],
          fetchedAt: Date.now()
        },
        [`${remoteScope}::workspace-1::search::query::20`]: {
          data: [{ ...issue('issue-id'), title: 'Remote title' }],
          fetchedAt: Date.now()
        }
      },
      linearListCache: {
        [`${localScope}::workspace-1::list::all::36`]: {
          data: { items: [{ ...issue('issue-id'), title: 'Local title' }] },
          fetchedAt: Date.now()
        },
        [`${remoteScope}::workspace-1::list::all::36`]: {
          data: { items: [{ ...issue('issue-id'), title: 'Remote title' }] },
          fetchedAt: Date.now()
        }
      }
    })

    store.getState().patchLinearIssue(
      'issue-id',
      { title: 'Patched local title' },
      {
        sourceContext: localSource
      }
    )

    expect(
      store.getState().linearIssueCache[`${localScope}::workspace-1::issue-id`]?.data?.title
    ).toBe('Patched local title')
    expect(
      store.getState().linearIssueCache[`${remoteScope}::workspace-1::issue-id`]?.data?.title
    ).toBe('Remote title')
    expect(
      store.getState().linearSearchCache[`${localScope}::workspace-1::search::query::20`]?.data?.[0]
        ?.title
    ).toBe('Patched local title')
    expect(
      store.getState().linearSearchCache[`${remoteScope}::workspace-1::search::query::20`]
        ?.data?.[0]?.title
    ).toBe('Remote title')
    expect(
      store.getState().linearListCache[`${localScope}::workspace-1::list::all::36`]?.data?.items[0]
        ?.title
    ).toBe('Patched local title')
    expect(
      store.getState().linearListCache[`${remoteScope}::workspace-1::list::all::36`]?.data?.items[0]
        ?.title
    ).toBe('Remote title')
  })
})
