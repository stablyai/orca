import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { LinearIssue, LinearTeam } from '../../../../shared/types'
import { createLinearSlice } from './linear'

const linearStatus = vi.fn()
const linearListIssues = vi.fn()
const linearSearchIssues = vi.fn()
const linearListTeams = vi.fn()

vi.mock('@/runtime/runtime-linear-client', () => ({
  linearConnect: vi.fn(),
  linearDisconnect: vi.fn(),
  linearDisconnectWorkspace: vi.fn(),
  linearGetIssue: vi.fn(),
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
      }
    })

    store.getState().patchLinearIssue('issue-id', { title: 'Updated' })

    expect(store.getState().linearIssueCache['workspace-1::issue-id'].data?.title).toBe('Updated')
    expect(store.getState().linearIssueCache['workspace-1::issue-id'].fetchedAt).toBe(0)
  })
})
