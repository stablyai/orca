import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type {
  LinearCollectionResult,
  LinearConnectionStatus,
  LinearViewer
} from '../../../../shared/linear/workspace-types'
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

  it('ignores stale status responses after the active runtime changes', async () => {
    const localStatus = deferred<LinearConnectionStatus>()
    const remoteStatus = deferred<LinearConnectionStatus>()
    const localViewer = {
      displayName: 'Local User',
      email: 'local@example.com',
      organizationName: 'Local Org'
    }
    const remoteViewer = {
      displayName: 'Remote User',
      email: 'remote@example.com',
      organizationName: 'Remote Org'
    }
    linearStatus.mockReturnValueOnce(localStatus.promise).mockReturnValueOnce(remoteStatus.promise)
    const store = createTestStore()

    const localRequest = store.getState().checkLinearConnection()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })
    const remoteRequest = store.getState().checkLinearConnection()

    remoteStatus.resolve({ connected: true, viewer: remoteViewer })
    await remoteRequest
    expect(store.getState().linearStatus.viewer?.email).toBe('remote@example.com')
    expect(store.getState().linearStatusContextKey).toBe('runtime:runtime-1#0')

    localStatus.resolve({ connected: true, viewer: localViewer })
    await localRequest
    expect(store.getState().linearStatus.viewer?.email).toBe('remote@example.com')
    expect(store.getState().linearStatusContextKey).toBe('runtime:runtime-1#0')
  })

  it('ignores stale list cache writes after the active runtime changes', async () => {
    const localList = deferred<LinearCollectionResult<LinearIssue>>()
    const remoteList = deferred<LinearCollectionResult<LinearIssue>>()
    linearListIssues.mockReturnValueOnce(localList.promise).mockReturnValueOnce(remoteList.promise)
    const store = createTestStore()
    store.setState({ linearStatus: { connected: true, viewer: null } })

    const localRequest = store
      .getState()
      .listLinearIssues({ kind: 'list', filter: 'assigned', limit: 20 })
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })
    const remoteRequest = store
      .getState()
      .listLinearIssues({ kind: 'list', filter: 'assigned', limit: 20 })

    remoteList.resolve({ items: [issue('LIN-REMOTE')] })
    await remoteRequest
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'assigned', limit: 20 })
    ).toMatchObject({ items: [{ id: 'LIN-REMOTE' }] })

    localList.resolve({ items: [issue('LIN-LOCAL')] })
    await localRequest
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'assigned', limit: 20 })
    ).toMatchObject({ items: [{ id: 'LIN-REMOTE' }] })
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

  it('ignores stale connect results after the active runtime changes', async () => {
    const connectResult = deferred<{ ok: true; viewer: LinearViewer }>()
    const viewer = {
      displayName: 'Local User',
      email: 'local@example.com',
      organizationName: 'Local Org'
    }
    linearConnect.mockReturnValueOnce(connectResult.promise)
    const store = createTestStore()

    const connectPromise = store.getState().connectLinear('linear-key')
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })

    connectResult.resolve({ ok: true, viewer })
    await expect(connectPromise).resolves.toEqual({
      ok: false,
      error: 'Linear connection was superseded by a newer request.'
    })

    expect(store.getState().linearStatus.connected).toBe(false)
    expect(store.getState().linearStatusContextKey).toBeNull()
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
