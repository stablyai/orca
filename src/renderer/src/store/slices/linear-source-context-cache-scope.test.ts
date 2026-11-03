import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearCollectionResult } from '../../../../shared/linear/workspace-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { createTestStore, deferred, issue } from './linear-slice-test-harness'

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
    linearListIssues: (...args: unknown[]) => linearListIssues(...args),
    linearSearchIssues: (...args: unknown[]) => linearSearchIssues(...args),
    linearSelectWorkspace: vi.fn(),
    linearStatus: (...args: unknown[]) => linearStatus(...args),
    linearTestConnection: (...args: unknown[]) => linearTestConnection(...args)
  }
})

vi.mock('@/runtime/runtime-linear-issue-mutations', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    linearGetIssue: (...args: unknown[]) => linearGetIssue(...args)
  }
})

vi.mock('@/runtime/runtime-linear-project-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    linearGetCustomView: (...args: unknown[]) => linearGetCustomView(...args),
    linearGetProject: (...args: unknown[]) => linearGetProject(...args),
    linearListCustomViewIssues: (...args: unknown[]) => linearListCustomViewIssues(...args),
    linearListCustomViewProjects: (...args: unknown[]) => linearListCustomViewProjects(...args),
    linearListCustomViews: (...args: unknown[]) => linearListCustomViews(...args),
    linearListProjectIssues: (...args: unknown[]) => linearListProjectIssues(...args),
    linearListProjects: (...args: unknown[]) => linearListProjects(...args),
    linearListTeams: (...args: unknown[]) => linearListTeams(...args)
  }
})

vi.mock('../../hooks/useIssueMetadata', () => ({
  clearLinearMetadataCache: vi.fn()
}))

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
  it('does not reuse an unscoped issue detail for an explicit source', async () => {
    const store = createTestStore()
    const sourceContext = linearSourceContext('source-runtime', 'source-workspace')
    store.setState({
      linearIssueCache: {
        'same-id': { data: { ...issue('same-id'), title: 'Wrong source' }, fetchedAt: Date.now() }
      }
    })
    linearGetIssue.mockResolvedValueOnce({ ...issue('same-id'), title: 'Correct source' })
    await expect(
      store.getState().fetchLinearIssue('same-id', 'source-workspace', { sourceContext })
    ).resolves.toMatchObject({ title: 'Correct source' })
    expect(linearGetIssue).toHaveBeenCalledWith(sourceContext, 'same-id', 'source-workspace')
  })
})
