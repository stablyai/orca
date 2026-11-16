import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceFromLinearData } from '../../src/main/linear/accounts/linear-workspace-record'

import type { LinearConnectionStatus, LinearViewer } from '../../src/shared/linear/workspace-types'
import { clearLinearRequestMaps } from '../../src/renderer/src/store/slices/linear/linear-slice-request-state'
import {
  createTestStore,
  deferred,
  issue
} from '../../src/renderer/src/store/slices/linear/linear-slice-test-harness'

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
const linearSelectWorkspace = vi.fn()
const linearDisconnectWorkspace = vi.fn()

vi.mock('@/runtime/linear/runtime-linear-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    linearConnect: (...args: unknown[]) => linearConnect(...args),
    linearDisconnect: (...args: unknown[]) => linearDisconnect(...args),
    linearDisconnectWorkspace: (...args: unknown[]) => linearDisconnectWorkspace(...args),
    linearListIssues: (...args: unknown[]) => linearListIssues(...args),
    linearSearchIssues: (...args: unknown[]) => linearSearchIssues(...args),
    linearSelectWorkspace: (...args: unknown[]) => linearSelectWorkspace(...args),
    linearStatus: (...args: unknown[]) => linearStatus(...args),
    linearTestConnection: (...args: unknown[]) => linearTestConnection(...args)
  }
})

vi.mock('@/runtime/linear/runtime-linear-issue-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    linearGetIssue: (...args: unknown[]) => linearGetIssue(...args)
  }
})

vi.mock('@/runtime/linear/runtime-linear-project-client', async (importOriginal) => {
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

vi.mock('../../src/renderer/src/hooks/useIssueMetadata', () => ({
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
      ok: true,
      viewer
    })

    expect(store.getState().linearStatus.connected).toBe(false)
    expect(store.getState().linearStatusContextKey).toBeNull()
    store.setState({
      linearSearchCache: {
        'other::search::warm::12': { data: [issue('old-runtime')], fetchedAt: 1 }
      }
    })
    const workspace = workspaceFromLinearData(viewer, { id: 'workspace-1', name: 'Remote Org' })
    linearConnect.mockResolvedValueOnce({ ok: true, viewer: workspace, workspace })
    await store.getState().connectLinear('new-runtime-key')
    expect(store.getState().linearSearchCache).toEqual({})
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

describe('account observations stay separate from query transport', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    clearLinearRequestMaps()
  })
  const confirmed: LinearConnectionStatus = {
    connected: true,
    viewer: null,
    selectedWorkspaceId: 'workspace-1',
    workspaces: [
      {
        id: 'workspace-1',
        organizationId: 'org',
        organizationName: 'Acme',
        displayName: 'User',
        email: null
      },
      {
        id: 'workspace-2',
        organizationId: 'org2',
        organizationName: 'Other',
        displayName: 'User',
        email: null
      }
    ]
  }
  function connectedStore() {
    const store = createTestStore()
    store.setState({
      linearStatus: confirmed,
      linearStatusObserved: true,
      linearStatusChecked: true,
      linearStatusContextKey: 'local#0'
    })
    return store
  }

  it('does not lose an actual Connect acknowledgement to a concurrent failed account delivery', async () => {
    const store = connectedStore()
    const ack = Promise.withResolvers<{
      ok: true
      viewer: LinearViewer
      workspace: NonNullable<LinearConnectionStatus['workspaces']>[number]
    }>()
    linearConnect.mockReturnValue(ack.promise)
    const action = store.getState().connectLinear('fixture-token')
    linearStatus.mockRejectedValue(new Error('unreachable'))
    await store.getState().checkLinearConnection(true)
    const workspace = workspaceFromLinearData(
      { displayName: 'User', email: null },
      { id: 'workspace-1', name: 'Acme' }
    )
    ack.resolve({ ok: true, viewer: workspace, workspace })
    await expect(action).resolves.toMatchObject({ ok: true })
    expect(
      store.getState().linearStatus.workspaces?.find((item) => item.id === workspace.id)
    ).toEqual(workspace)
  })
})
