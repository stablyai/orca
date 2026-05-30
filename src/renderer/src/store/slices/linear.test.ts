import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { LinearConnectionStatus, LinearIssue, LinearViewer } from '../../../../shared/types'
import { createLinearSlice } from './linear'

const linearStatus = vi.fn()
const linearConnect = vi.fn()
const linearDisconnect = vi.fn()
const linearListIssues = vi.fn()
const linearSearchIssues = vi.fn()
const linearListTeams = vi.fn()
const linearGetIssue = vi.fn()
const linearTestConnection = vi.fn()

vi.mock('@/runtime/runtime-linear-client', () => ({
  linearConnect: (...args: unknown[]) => linearConnect(...args),
  linearDisconnect: (...args: unknown[]) => linearDisconnect(...args),
  linearDisconnectWorkspace: vi.fn(),
  linearGetIssue: (...args: unknown[]) => linearGetIssue(...args),
  linearListIssues: (...args: unknown[]) => linearListIssues(...args),
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
