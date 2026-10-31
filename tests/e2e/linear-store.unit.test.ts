import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceFromLinearData } from '../../src/main/linear/linear-workspace-record'
import { credentialDecryptionMessage } from '../../src/shared/integration-credential-errors'
import type { LinearIssue } from '../../src/shared/linear/issue-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../src/shared/task-source-context'
import type {
  LinearCollectionResult,
  LinearConnectionStatus,
  LinearViewer
} from '../../src/shared/linear/workspace-types'
import {
  clearLinearRequestMaps,
  getInflightStatusRequest
} from '../../src/renderer/src/store/slices/linear/linear-slice-request-state'
import {
  createTestStore,
  deferred,
  issue
} from '../../src/renderer/src/store/slices/linear-slice-test-harness'

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

vi.mock('@/runtime/runtime-linear-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    linearConnect: (...args: unknown[]) => linearConnect(...args),
    linearDisconnect: (...args: unknown[]) => linearDisconnect(...args),
    linearDisconnectWorkspace: (...args: unknown[]) => linearDisconnectWorkspace(...args),
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
    linearSelectWorkspace: (...args: unknown[]) => linearSelectWorkspace(...args),
    linearStatus: (...args: unknown[]) => linearStatus(...args),
    linearTestConnection: (...args: unknown[]) => linearTestConnection(...args)
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

  it('preserves status identity when a connection probe leaves its scope unchanged', async () => {
    const store = createTestStore()
    const currentStatus: LinearConnectionStatus = {
      connected: true,
      viewer: {
        displayName: 'Test User',
        email: 'test@example.com',
        organizationName: 'Test Org'
      },
      selectedWorkspaceId: 'workspace-1',
      activeWorkspaceId: 'workspace-1',
      workspaces: [
        {
          id: 'workspace-1',
          organizationId: 'workspace-1',
          organizationName: 'Test Org',
          displayName: 'Test User',
          email: 'test@example.com'
        }
      ]
    }
    store.setState({
      linearStatus: currentStatus,
      linearStatusChecked: true,
      linearStatusContextKey: 'local#0'
    })
    linearTestConnection.mockResolvedValueOnce({ ok: true, viewer: currentStatus.viewer })
    linearStatus.mockResolvedValueOnce({ ...currentStatus, viewer: { ...currentStatus.viewer } })

    await store.getState().testLinearConnection()

    expect(store.getState().linearStatus).toBe(currentStatus)
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
    await expect(localRequest).rejects.toThrow('Linear read abandoned')
    expect(
      store.getState().getCachedLinearIssues({ kind: 'list', filter: 'assigned', limit: 20 })
    ).toMatchObject({ items: [{ id: 'LIN-REMOTE' }] })
  })

  it('ignores stale status checks after a successful connect', async () => {
    const staleMountCheck = deferred<LinearConnectionStatus>()
    const viewer = {
      displayName: 'Test User',
      email: 'test@example.com',
      organizationName: 'Test Org'
    }
    linearStatus.mockReturnValueOnce(staleMountCheck.promise)
    linearConnect.mockResolvedValueOnce({ ok: true, viewer })
    const store = createTestStore()

    const mountCheck = store.getState().checkLinearConnection()
    const connectPromise = store.getState().connectLinear('linear-key')
    await Promise.resolve()

    expect(linearStatus).toHaveBeenCalledTimes(1)

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

  it('preserves an actual Connect result while a later account snapshot owns availability', async () => {
    const connectResult = deferred<{ ok: true; viewer: LinearViewer }>()
    const viewer = { displayName: 'User', email: null, organizationName: 'Org' }
    linearConnect.mockReturnValueOnce(connectResult.promise)
    linearStatus.mockResolvedValue({ connected: false, viewer: null })
    const store = createTestStore()
    const connect = store.getState().connectLinear('linear-key')
    await store.getState().checkLinearConnection(true)
    connectResult.resolve({ ok: true, viewer })
    await expect(connect).resolves.toEqual({ ok: true, viewer })
    expect(store.getState().linearStatus.connected).toBe(false)
    expect(linearStatus).toHaveBeenCalledTimes(1)
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
  it('consumes exact Connect/test/disconnect acknowledgements even when status delivery fails', async () => {
    const store = connectedStore()
    const workspace = { ...confirmed.workspaces![0], displayName: 'User', email: null }
    const acknowledgement = { ok: true, viewer: workspace, workspace }
    linearStatus.mockRejectedValue(new Error('unreachable'))
    linearDisconnectWorkspace.mockResolvedValue(undefined)
    await store.getState().disconnectLinearWorkspace(workspace.id)
    expect(store.getState().linearStatus.workspaces?.map((item) => item.id)).toEqual([
      'workspace-2'
    ])
    linearConnect.mockResolvedValue(acknowledgement)
    await expect(store.getState().connectLinear('fixture-token')).resolves.toEqual(acknowledgement)
    expect(store.getState().linearStatus.workspaces?.map((item) => item.id)).toEqual([
      'workspace-2',
      'workspace-1'
    ])
    linearTestConnection.mockResolvedValue(acknowledgement)
    await expect(store.getState().testLinearConnection(workspace.id)).resolves.toEqual(
      acknowledgement
    )
    expect(store.getState().linearStatus.connected).toBe(true)
    expect(linearStatus).not.toHaveBeenCalled()
  })
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
  it('revalidates repeated revisionless acknowledgements only in their scope and preserves another scope credential error', async () => {
    const store = connectedStore()
    const workspace = workspaceFromLinearData(
      { displayName: 'User', email: null },
      { id: 'workspace-1', name: 'Acme' }
    )
    const error = credentialDecryptionMessage('Linear')
    store.setState({ linearStatus: { ...confirmed, credentialError: error } })
    const acknowledgement = { ok: true, viewer: workspace, workspace }
    linearConnect.mockResolvedValue(acknowledgement)
    linearTestConnection.mockResolvedValue(acknowledgement)
    linearStatus.mockRejectedValue(new Error('unreachable'))
    linearSearchIssues.mockResolvedValue([issue('healthy')])
    const read = (workspaceId: string | null) =>
      store.getState().searchLinearIssues('warm', 12, { workspaceId })
    await read('workspace-2')
    await getInflightStatusRequest()?.promise
    const healthy = store.getState().linearSearchCache['workspace-2::search::warm::12']
    for (const action of ['connect', 'connect', 'test'] as const) {
      await read('workspace-1')
      await read(null)
      await getInflightStatusRequest()?.promise
      const calls = linearSearchIssues.mock.calls.length
      await (action === 'connect'
        ? store.getState().connectLinear('fixture-token')
        : store.getState().testLinearConnection(workspace.id))
      expect(store.getState().linearStatus.credentialError).toBe(error)
      expect(store.getState().linearSearchCache['workspace-1::search::warm::12']).toBeUndefined()
      expect(store.getState().linearSearchCache['default::search::warm::12']).toBeUndefined()
      expect(store.getState().linearSearchCache['workspace-2::search::warm::12']).toBe(healthy)
      await read('workspace-1')
      await getInflightStatusRequest()?.promise
      await read(null)
      await read('workspace-2')
      await getInflightStatusRequest()?.promise
      expect(linearSearchIssues).toHaveBeenCalledTimes(calls + 2)
      expect(store.getState().linearStatus.workspaces?.map((item) => item.id)).toEqual([
        'workspace-2',
        'workspace-1'
      ])
    }
    expect(workspace).not.toHaveProperty('credentialRevision')
  })
  it('does not turn SSH authentication or a renderer-synthesized auth error into account rejection', async () => {
    const store = connectedStore()
    store.setState({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only active runtime is read from these fixture settings.
      settings: { activeRuntimeEnvironmentId: 'remote' } as never,
      linearStatusContextKey: 'runtime:remote#0'
    })
    linearStatus.mockRejectedValue(new Error('unreachable'))
    linearListProjectIssues.mockRejectedValue(
      new Error('Timed out while waiting for SSH authentication')
    )
    const result = await store.getState().listLinearProjectIssues('project', 'workspace-1')
    expect(result?.errors).toMatchObject([{ workspaceId: 'workspace-1', type: 'unknown' }])
    await getInflightStatusRequest()?.promise
    expect(store.getState().linearStatus).toBe(confirmed)
    expect(getInflightStatusRequest()).toBeNull()
  })
  it('does not let a held select snapshot re-add a scope rejected by the handler when status fails', async () => {
    const store = connectedStore()
    const held = deferred<LinearConnectionStatus>()
    linearSelectWorkspace.mockReturnValue(held.promise)
    const select = store.getState().selectLinearWorkspace('workspace-1')
    linearStatus.mockRejectedValue(new Error('unreachable'))
    linearListIssues.mockResolvedValue({
      items: [{ ...issue('healthy'), workspaceId: 'workspace-2' }],
      errors: [
        {
          workspaceId: 'workspace-1',
          type: 'auth',
          message: 'Linear authentication expired for this workspace.'
        }
      ]
    })
    await store.getState().listLinearIssues({ kind: 'list' }, { workspaceId: 'all' })
    await getInflightStatusRequest()?.promise
    held.resolve(confirmed)
    await select
    expect(store.getState().linearStatus.workspaces?.map((item) => item.id)).toEqual([
      'workspace-2'
    ])
  })
  it('retains healthy concrete and aggregate cached observations during affected-scope revalidation', async () => {
    const store = connectedStore()
    const healthy = { ...issue('healthy'), workspaceId: 'workspace-2' }
    linearSearchIssues.mockResolvedValue([healthy])
    await store.getState().searchLinearIssues('warm', 12, { workspaceId: 'workspace-2' })
    await store.getState().searchLinearIssues('warm', 12, { workspaceId: 'all' })
    const sources: TaskSourceContext[] = [
      { kind: 'task-source', provider: 'linear', projectId: 'project', hostId: 'local' },
      {
        kind: 'task-source',
        provider: 'linear',
        projectId: 'project',
        hostId: 'local',
        accountLabel: 'Account'
      },
      { kind: 'task-source', provider: 'linear', projectId: 'project', hostId: 'runtime:foreign' }
    ]
    for (const sourceContext of sources) {
      for (const workspaceId of ['workspace-1', 'workspace-2', 'all']) {
        await store.getState().searchLinearIssues('warm', 12, { workspaceId, sourceContext })
      }
    }
    linearStatus.mockResolvedValue({
      ...confirmed,
      workspaces: [confirmed.workspaces![1]],
      selectedWorkspaceId: 'workspace-2'
    })
    await store.getState().checkLinearConnection(true)
    expect(store.getState().linearSearchCache['workspace-2::search::warm::12']?.data).toEqual([
      healthy
    ])
    expect(store.getState().linearSearchCache['all::search::warm::12']?.data).toEqual([healthy])
    for (const source of sources) {
      const prefix = getTaskSourceCacheScope(source)
      expect(
        store.getState().linearSearchCache[`${prefix}::workspace-2::search::warm::12`]?.data
      ).toEqual([healthy])
      expect(store.getState().linearSearchCache[`${prefix}::all::search::warm::12`]?.data).toEqual([
        healthy
      ])
      expect(
        Boolean(store.getState().linearSearchCache[`${prefix}::workspace-1::search::warm::12`])
      ).toBe(source.hostId !== 'local')
    }
  })
  it('keeps matching confirmed status/cache on failure, terminates cold unknown, and accepts actual false/disconnect', async () => {
    const store = connectedStore()
    store.setState({ linearIssueCache: { warm: { data: issue('warm'), fetchedAt: 1 } } })
    linearStatus.mockRejectedValue(new Error('unreachable'))
    await store.getState().checkLinearConnection(true)
    expect(store.getState().linearStatus).toBe(confirmed)
    expect(store.getState().linearIssueCache.warm.data?.id).toBe('warm')
    expect(getInflightStatusRequest()).toBeNull()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture exercises only the runtime setting; unrelated GlobalSettings are not read.
    store.setState({ settings: { activeRuntimeEnvironmentId: 'other' } as never })
    await store.getState().checkLinearConnection(true)
    expect(store.getState()).toMatchObject({
      linearStatus: { connected: false },
      linearStatusObserved: false,
      linearStatusChecked: true,
      linearStatusContextKey: 'runtime:other#0'
    })
    store.setState({ settings: null })
    linearStatus.mockResolvedValue({ connected: false, viewer: null })
    await store.getState().checkLinearConnection(true)
    expect(store.getState()).toMatchObject({
      linearStatusObserved: true,
      linearStatus: { connected: false }
    })
    store.setState({ linearStatus: confirmed })
    linearDisconnect.mockResolvedValue(undefined)
    await store.getState().disconnectLinear()
    expect(store.getState().linearStatus.connected).toBe(false)
  })
  it.each([false, true])(
    'successful all-workspace list with partial=%s survives failed account delivery',
    async (partial) => {
      const store = connectedStore()
      const result: LinearCollectionResult<LinearIssue> = {
        items: [{ ...issue('healthy'), workspaceId: 'workspace-2' }],
        ...(partial
          ? {
              errors: [
                {
                  workspaceId: 'workspace-1',
                  type: 'auth' as const,
                  message: 'Linear authentication expired for this workspace.'
                }
              ]
            }
          : {})
      }
      linearListIssues.mockResolvedValue(result)
      linearStatus.mockRejectedValue(new Error('unreachable'))
      await expect(
        store.getState().listLinearIssues({ kind: 'list' }, { workspaceId: 'all' })
      ).resolves.toEqual(result)
      await getInflightStatusRequest()?.promise
      expect(store.getState().linearStatus.workspaces?.map((workspace) => workspace.id)).toEqual(
        partial ? ['workspace-2'] : ['workspace-1', 'workspace-2']
      )
      expect(
        store.getState().getCachedLinearIssues({ kind: 'list' }, { workspaceId: 'all' })
      ).toEqual(result)
      expect(getInflightStatusRequest()).toBeNull()
    }
  )
  it('old-host ambiguous empty Retry keeps main query behavior without a status veto', async () => {
    const store = connectedStore()
    linearSearchIssues
      .mockRejectedValueOnce(new Error('401 raw old-host diagnostic'))
      .mockResolvedValue([])
    linearStatus.mockRejectedValue(new Error('unreachable'))
    await expect(store.getState().searchLinearIssues('legacy', 12)).rejects.toThrow('401')
    await getInflightStatusRequest()?.promise
    await expect(
      store.getState().searchLinearIssues('legacy', 12, { force: true })
    ).resolves.toEqual([])
    expect(store.getState().linearStatus.connected).toBe(true)
    linearStatus.mockResolvedValue(confirmed)
    await expect(
      store.getState().searchLinearIssues('legacy', 12, { force: true })
    ).resolves.toEqual([])
    expect(getInflightStatusRequest()).toBeNull()
  })
  it.each([20, 200])(
    'real %i-read cohorts bound query and account operations independently',
    async (N) => {
      const store = connectedStore()
      store.setState({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only active runtime is read from these fixture settings.
        settings: { activeRuntimeEnvironmentId: 'cohort' } as never,
        linearStatusContextKey: 'runtime:cohort#0'
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      linearStatus.mockResolvedValue(confirmed)
      linearSearchIssues.mockRejectedValue(new Error('ordinary transport outage'))
      await Promise.allSettled(
        Array.from({ length: N }, (_, i) => store.getState().searchLinearIssues(`generic-${i}`, 12))
      )
      expect(linearSearchIssues).toHaveBeenCalledTimes(N)
      expect(linearStatus).toHaveBeenCalledTimes(0)
      linearSearchIssues.mockRejectedValue(
        new Error('Linear authentication expired for this workspace.')
      )
      await Promise.allSettled(
        Array.from({ length: N }, (_, i) => store.getState().searchLinearIssues(`auth-${i}`, 12))
      )
      await getInflightStatusRequest()?.promise
      expect(linearSearchIssues).toHaveBeenCalledTimes(2 * N)
      expect(linearStatus).toHaveBeenCalledTimes(1)
      // Later incompatible cohorts must dispatch again; there is no arbitrary-Q bound of one.
      await Promise.allSettled([store.getState().searchLinearIssues('later-auth', 12)])
      await getInflightStatusRequest()?.promise
      expect(linearStatus).toHaveBeenCalledTimes(2)
      expect(getInflightStatusRequest()).toBeNull()
      warn.mockRestore()
    }
  )
  it.each(['force', 'runtime', 'mutation'] as const)(
    'queued automatic probe cannot dispatch after %s supersedes it',
    async (successor) => {
      const store = connectedStore()
      linearStatus.mockResolvedValue(confirmed)
      linearDisconnect.mockResolvedValue(undefined)
      linearSearchIssues.mockRejectedValue(new Error('401 auth failure'))
      const lease = store.getState().searchLinearIssues('queued', 12).acquire()
      let next: Promise<void> | undefined
      lease.subscribe(() => {
        if (lease.currentView().kind === 'error') {
          queueMicrotask(() => {
            if (successor === 'force') {
              next = store.getState().checkLinearConnection(true)
            } else if (successor === 'mutation') {
              next = store.getState().disconnectLinear()
            } else {
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture exercises only the runtime setting; unrelated GlobalSettings are not read.
              store.setState({ settings: { activeRuntimeEnvironmentId: 'new' } as never })
            }
          })
        }
      })
      await lease.waitForCurrentTerminal()
      lease.release()
      await Promise.resolve()
      await next
      await Promise.resolve()
      expect(linearStatus).toHaveBeenCalledTimes(successor === 'force' ? 1 : 0)
      expect(getInflightStatusRequest()).toBeNull()
    }
  )
})
