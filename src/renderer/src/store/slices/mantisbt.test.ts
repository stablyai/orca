import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { MantisBTConnectionStatus, MantisBTViewer } from '../../../../shared/mantisbt-types'
import { createMantisBTSlice } from './mantisbt'

const mantisBTStatus = vi.fn()
const mantisBTConnect = vi.fn()
const mantisBTDisconnect = vi.fn()
const mantisBTSelectSite = vi.fn()
const mantisBTTestConnection = vi.fn()

vi.mock('@/runtime/runtime-mantisbt-client', () => ({
  mantisBTStatus: (...args: unknown[]) => mantisBTStatus(...args),
  mantisBTConnect: (...args: unknown[]) => mantisBTConnect(...args),
  mantisBTDisconnect: (...args: unknown[]) => mantisBTDisconnect(...args),
  mantisBTSelectSite: (...args: unknown[]) => mantisBTSelectSite(...args),
  mantisBTTestConnection: (...args: unknown[]) => mantisBTTestConnection(...args)
}))

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test store wires only the MantisBT slice, not every AppState slice; mirrors the equivalent Jira slice test.
      ({
        settings: null,
        ...createMantisBTSlice(...a)
      }) as AppState
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function viewer(displayName: string): MantisBTViewer {
  return { id: displayName, displayName }
}

function connectedStatus(displayName: string, siteId = 'site-1'): MantisBTConnectionStatus {
  return {
    connected: true,
    viewer: viewer(displayName),
    sites: [
      {
        id: siteId,
        siteUrl: `https://${siteId}.example.com`,
        userId: '1',
        displayName: siteId,
        authScheme: 'bearer',
        usePhpIndexPath: false
      }
    ],
    activeSiteId: siteId,
    selectedSiteId: siteId
  }
}

const disconnectedStatus: MantisBTConnectionStatus = {
  connected: false,
  viewer: null,
  sites: [],
  activeSiteId: null,
  selectedSiteId: null
}

describe('createMantisBTSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ignores a stale checkMantisBTConnection response after the active runtime changes', async () => {
    const store = createTestStore()
    const localStatus = deferred<MantisBTConnectionStatus>()
    const remoteStatus = deferred<MantisBTConnectionStatus>()
    mantisBTStatus
      .mockReturnValueOnce(localStatus.promise)
      .mockReturnValueOnce(remoteStatus.promise)

    const localRequest = store.getState().checkMantisBTConnection()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only partial settings override; only activeRuntimeEnvironmentId is read by getProviderRuntimeContextKey here.
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })
    const remoteRequest = store.getState().checkMantisBTConnection()

    remoteStatus.resolve(connectedStatus('remote'))
    await remoteRequest
    expect(store.getState().mantisBTStatus.viewer?.displayName).toBe('remote')
    expect(store.getState().mantisBTStatusContextKey).toBe('runtime:runtime-1#0')

    localStatus.resolve(connectedStatus('local'))
    await localRequest
    expect(store.getState().mantisBTStatus.viewer?.displayName).toBe('remote')
    expect(store.getState().mantisBTStatusContextKey).toBe('runtime:runtime-1#0')
  })

  it('marks the status checked without overwriting state when nothing changed', async () => {
    const store = createTestStore()
    mantisBTStatus.mockResolvedValueOnce(disconnectedStatus)

    await store.getState().checkMantisBTConnection()

    expect(store.getState().mantisBTStatusChecked).toBe(true)
    expect(store.getState().mantisBTStatusContextKey).toBe('local#0')
    expect(store.getState().mantisBTStatus).toEqual(disconnectedStatus)
  })

  it('treats a credentialError-only status change as a real change', async () => {
    const store = createTestStore()
    store.setState({
      mantisBTStatus: disconnectedStatus,
      mantisBTStatusChecked: true,
      mantisBTStatusContextKey: 'local#0'
    })
    mantisBTStatus.mockResolvedValueOnce({
      ...disconnectedStatus,
      credentialError: 'Secret decryption failed'
    })

    await store.getState().checkMantisBTConnection()

    expect(store.getState().mantisBTStatus.credentialError).toBe('Secret decryption failed')
    expect(store.getState().mantisBTConnectionRevisions['local#0']).toBe(1)
  })

  it('falls back to a disconnected status when a connection check throws while connected', async () => {
    const store = createTestStore()
    store.setState({
      mantisBTStatus: connectedStatus('local'),
      mantisBTStatusChecked: true,
      mantisBTStatusContextKey: 'local#0'
    })
    mantisBTStatus.mockRejectedValueOnce(new Error('network error'))

    await store.getState().checkMantisBTConnection()

    expect(store.getState().mantisBTStatus.connected).toBe(false)
    expect(store.getState().mantisBTConnectionRevisions['local#0']).toBe(1)
  })

  it('returns a failed connect result when the active runtime changes before completion', async () => {
    const store = createTestStore()
    const connectResult = deferred<{ ok: true; viewer: MantisBTViewer }>()
    mantisBTConnect.mockReturnValueOnce(connectResult.promise)

    const request = store.getState().connectMantisBT({
      siteUrl: 'https://mantisbt.example.com',
      apiToken: 'token'
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only partial settings override; only activeRuntimeEnvironmentId is read by getProviderRuntimeContextKey here.
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })

    connectResult.resolve({ ok: true, viewer: viewer('local') })
    await expect(request).resolves.toEqual({
      ok: false,
      error: 'MantisBT connection was superseded by a newer request.'
    })
    expect(store.getState().mantisBTStatus.connected).toBe(false)
    expect(store.getState().mantisBTStatusContextKey).toBeNull()
  })

  it('optimistically marks connected and refreshes status after a successful connect', async () => {
    const store = createTestStore()
    mantisBTConnect.mockResolvedValueOnce({
      ok: true,
      viewer: viewer('ada')
    })
    mantisBTStatus.mockResolvedValueOnce(connectedStatus('ada'))

    const result = await store.getState().connectMantisBT({
      siteUrl: 'https://mantisbt.example.com',
      apiToken: 'token'
    })

    expect(result).toEqual({ ok: true, viewer: viewer('ada') })
    expect(store.getState().mantisBTStatus.connected).toBe(true)
    expect(store.getState().mantisBTStatus.viewer?.displayName).toBe('ada')
  })

  it('returns the connect failure without mutating status', async () => {
    const store = createTestStore()
    mantisBTConnect.mockResolvedValueOnce({ ok: false, error: 'Invalid API token' })

    const result = await store.getState().connectMantisBT({
      siteUrl: 'https://mantisbt.example.com',
      apiToken: 'bad-token'
    })

    expect(result).toEqual({ ok: false, error: 'Invalid API token' })
    expect(store.getState().mantisBTStatus.connected).toBe(false)
    expect(mantisBTStatus).not.toHaveBeenCalled()
  })

  it('converts a thrown connect error into a graceful failure result', async () => {
    const store = createTestStore()
    mantisBTConnect.mockRejectedValueOnce(new Error('Network unreachable'))

    const result = await store.getState().connectMantisBT({
      siteUrl: 'https://mantisbt.example.com',
      apiToken: 'token'
    })

    expect(result).toEqual({ ok: false, error: 'Network unreachable' })
  })

  it('does not run a stale test-connection follow-up status check after the active runtime changes', async () => {
    const store = createTestStore()
    const testResult = deferred<{ ok: true; viewer: MantisBTViewer }>()
    mantisBTTestConnection.mockReturnValueOnce(testResult.promise)

    const request = store.getState().testMantisBTConnection()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only partial settings override; only activeRuntimeEnvironmentId is read by getProviderRuntimeContextKey here.
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })

    testResult.resolve({ ok: true, viewer: viewer('local') })
    await request
    expect(mantisBTStatus).not.toHaveBeenCalled()
  })

  it('refreshes status after a successful test-connection while the runtime is still current', async () => {
    const store = createTestStore()
    mantisBTTestConnection.mockResolvedValueOnce({
      ok: true,
      viewer: viewer('ada')
    })
    mantisBTStatus.mockResolvedValueOnce(connectedStatus('ada'))

    const result = await store.getState().testMantisBTConnection('site-1')

    expect(result).toEqual({ ok: true, viewer: viewer('ada') })
    expect(mantisBTStatus).toHaveBeenCalledTimes(1)
    expect(store.getState().mantisBTStatus.connected).toBe(true)
  })

  it('ignores a stale selectMantisBTSite response after the active runtime changes', async () => {
    const store = createTestStore()
    mantisBTSelectSite.mockResolvedValueOnce(connectedStatus('local', 'site-2'))

    const request = store.getState().selectMantisBTSite('site-2')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only partial settings override; only activeRuntimeEnvironmentId is read by getProviderRuntimeContextKey here.
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })
    await request

    expect(store.getState().mantisBTStatusContextKey).toBeNull()
  })

  it('updates status and publishes a revision after selecting a site', async () => {
    const store = createTestStore()
    mantisBTSelectSite.mockResolvedValueOnce(connectedStatus('local', 'site-2'))

    await store.getState().selectMantisBTSite('site-2')

    expect(store.getState().mantisBTStatus.selectedSiteId).toBe('site-2')
    expect(store.getState().mantisBTConnectionRevisions['local#0']).toBe(1)
  })

  it('does not refresh stale disconnect results after the active runtime changes', async () => {
    const store = createTestStore()
    const disconnectResult = deferred<void>()
    mantisBTDisconnect.mockReturnValueOnce(disconnectResult.promise)

    const request = store.getState().disconnectMantisBT()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only partial settings override; only activeRuntimeEnvironmentId is read by getProviderRuntimeContextKey here.
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })

    disconnectResult.resolve()
    await request
    expect(mantisBTStatus).not.toHaveBeenCalled()
  })

  it('publishes a connection revision after disconnecting the active site', async () => {
    const store = createTestStore()
    mantisBTDisconnect.mockResolvedValueOnce(undefined)
    mantisBTStatus.mockResolvedValueOnce(disconnectedStatus)

    await store.getState().disconnectMantisBT()

    expect(store.getState().mantisBTConnectionRevisions['local#0']).toBe(1)
    expect(store.getState().mantisBTStatus.connected).toBe(false)
  })

  it('keeps the remaining sites connected when disconnecting one of several sites', async () => {
    const store = createTestStore()
    mantisBTDisconnect.mockResolvedValueOnce(undefined)
    mantisBTStatus.mockResolvedValueOnce(connectedStatus('local', 'site-2'))

    await store.getState().disconnectMantisBT('site-1')

    expect(store.getState().mantisBTStatus.connected).toBe(true)
    expect(store.getState().mantisBTStatus.selectedSiteId).toBe('site-2')
  })

  it('collapses to the disconnected shape when the last site is disconnected', async () => {
    const store = createTestStore()
    store.setState({ mantisBTStatus: connectedStatus('local') })
    mantisBTDisconnect.mockResolvedValueOnce(undefined)
    mantisBTStatus.mockResolvedValueOnce({ ...disconnectedStatus, connected: false })

    await store.getState().disconnectMantisBT('site-1')

    expect(store.getState().mantisBTStatus).toEqual(disconnectedStatus)
  })
})
