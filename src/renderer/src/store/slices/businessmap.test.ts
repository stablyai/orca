import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/constants'
import type {
  BusinessmapCard,
  BusinessmapConnectionStatus,
  BusinessmapViewer
} from '../../../../shared/businessmap-types'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { credentialDecryptionMessage } from '../../../../shared/integration-credential-errors'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { createBusinessmapSlice } from './businessmap'

const businessmapStatus = vi.fn()
const businessmapConnect = vi.fn()
const businessmapCreateCard = vi.fn()
const businessmapDisconnect = vi.fn()
const businessmapGetCard = vi.fn()
const businessmapListBoards = vi.fn()
const businessmapListCards = vi.fn()
const businessmapReadStatus = vi.fn()
const businessmapSearchCards = vi.fn()
const businessmapSelectSite = vi.fn()
const businessmapTestConnection = vi.fn()
const businessmapUpdateCard = vi.fn()
vi.mock('@/runtime/runtime-businessmap-client', () => ({
  businessmapAddCardComment: vi.fn(),
  businessmapConnect: (...args: unknown[]) => businessmapConnect(...args),
  businessmapCreateCard: (...args: unknown[]) => businessmapCreateCard(...args),
  businessmapDisconnect: (...args: unknown[]) => businessmapDisconnect(...args),
  businessmapGetBoardTree: vi.fn(),
  businessmapGetCard: (...args: unknown[]) => businessmapGetCard(...args),
  businessmapIssueComments: vi.fn(),
  businessmapListBoards: (...args: unknown[]) => businessmapListBoards(...args),
  businessmapListCards: (...args: unknown[]) => businessmapListCards(...args),
  businessmapReadStatus: (...args: unknown[]) => businessmapReadStatus(...args),
  businessmapSearchCards: (...args: unknown[]) => businessmapSearchCards(...args),
  businessmapSelectSite: (...args: unknown[]) => businessmapSelectSite(...args),
  businessmapStatus: (...args: unknown[]) => businessmapStatus(...args),
  businessmapTestConnection: (...args: unknown[]) => businessmapTestConnection(...args),
  businessmapUpdateCard: (...args: unknown[]) => businessmapUpdateCard(...args)
}))

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        settings: null,
        ...createBusinessmapSlice(...a)
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

function status(subdomain: string): BusinessmapConnectionStatus {
  return { connected: true, viewer: { displayName: 'Ada', subdomain } }
}

function card(id: number): BusinessmapCard {
  return {
    id,
    boardId: 7,
    title: `Card ${id}`,
    url: `https://example.businessmap.io/card/${id}`,
    column: { id: 3, name: 'Doing' },
    workflowId: 1,
    labels: [],
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function businessmapSourceContext(environmentId: string): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'businessmap',
    projectId: 'logical-project',
    hostId: `runtime:${environmentId}`,
    providerIdentity: {
      provider: 'businessmap',
      subdomain: 'acme'
    }
  }
}

describe('createBusinessmapSlice runtime context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Why: GlobalSettings has 100+ required fields; spread full defaults and override one key.
  function runtimeSettingsState(environmentId: string): { settings: GlobalSettings } {
    return {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: environmentId }
    }
  }
  it('ignores stale status responses after the active runtime changes', async () => {
    const store = createTestStore()
    const localStatus = deferred<BusinessmapConnectionStatus>()
    const remoteStatus = deferred<BusinessmapConnectionStatus>()
    businessmapStatus
      .mockReturnValueOnce(localStatus.promise)
      .mockReturnValueOnce(remoteStatus.promise)

    const localRequest = store.getState().checkBusinessmapConnection()
    store.setState(runtimeSettingsState('runtime-1'))
    const remoteRequest = store.getState().checkBusinessmapConnection()

    remoteStatus.resolve(status('remote'))
    await remoteRequest
    expect(store.getState().businessmapStatus.viewer?.subdomain).toBe('remote')
    expect(store.getState().businessmapStatusContextKey).toBe('runtime:runtime-1#0')

    localStatus.resolve(status('local'))
    await localRequest
    expect(store.getState().businessmapStatus.viewer?.subdomain).toBe('remote')
    expect(store.getState().businessmapStatusContextKey).toBe('runtime:runtime-1#0')
  })

  it('ignores stale card cache writes after the active runtime changes', async () => {
    const store = createTestStore()
    const localCard = deferred<BusinessmapCard | null>()
    const remoteCard = deferred<BusinessmapCard | null>()
    businessmapGetCard
      .mockReturnValueOnce(localCard.promise)
      .mockReturnValueOnce(remoteCard.promise)

    const localRequest = store.getState().fetchBusinessmapCard(42)
    store.setState(runtimeSettingsState('runtime-1'))
    const remoteRequest = store.getState().fetchBusinessmapCard(42)

    remoteCard.resolve({ ...card(42), title: 'Remote card' })
    await remoteRequest
    expect(store.getState().businessmapCardCache['selected::42']?.data?.title).toBe('Remote card')

    localCard.resolve({ ...card(42), title: 'Local card' })
    await localRequest
    expect(store.getState().businessmapCardCache['selected::42']?.data?.title).toBe('Remote card')
  })

  it('does not repopulate an old-site cache after selecting a new site', async () => {
    const store = createTestStore()
    const oldSiteCards = deferred<BusinessmapCard[]>()
    store.setState({
      businessmapStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    businessmapSearchCards.mockReturnValueOnce(oldSiteCards.promise)
    businessmapSelectSite.mockResolvedValueOnce({
      connected: true,
      viewer: null,
      selectedSiteId: 'site-2'
    })

    const oldSiteRequest = store.getState().searchBusinessmapCards('doing', 30)
    await store.getState().selectBusinessmapSite('site-2')
    oldSiteCards.resolve([card(1)])

    await expect(oldSiteRequest).resolves.toMatchObject([{ id: 1 }])
    expect(store.getState().businessmapStatus.selectedSiteId).toBe('site-2')
    expect(store.getState().businessmapSearchCache).toEqual({})
  })

  it('isolates out-of-order card reads from different source hosts', async () => {
    const store = createTestStore()
    const sourceA = businessmapSourceContext('runtime-a')
    const sourceB = businessmapSourceContext('runtime-b')
    const runtimeACard = deferred<BusinessmapCard | null>()
    const runtimeBCard = deferred<BusinessmapCard | null>()
    businessmapGetCard
      .mockReturnValueOnce(runtimeACard.promise)
      .mockReturnValueOnce(runtimeBCard.promise)

    const requestA = store.getState().fetchBusinessmapCard(9, 'site-1', {
      sourceContext: sourceA
    })
    const requestB = store.getState().fetchBusinessmapCard(9, 'site-1', {
      sourceContext: sourceB
    })
    runtimeBCard.resolve({ ...card(9), title: 'Runtime B' })
    await requestB
    runtimeACard.resolve({ ...card(9), title: 'Runtime A' })
    await requestA

    expect(
      store.getState().businessmapCardCache[`${getTaskSourceCacheScope(sourceA)}::site-1::9`]?.data
        ?.title
    ).toBe('Runtime A')
    expect(
      store.getState().businessmapCardCache[`${getTaskSourceCacheScope(sourceB)}::site-1::9`]?.data
        ?.title
    ).toBe('Runtime B')
  })

  it('routes explicit source reads through their source context when focused runtime changes', async () => {
    const store = createTestStore()
    store.setState({
      businessmapStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    const sourceContext = businessmapSourceContext('source-runtime')
    const sourceResult = deferred<BusinessmapCard[]>()
    businessmapListCards.mockReturnValueOnce(sourceResult.promise)

    const request = store.getState().listBusinessmapCards('assigned', 30, { sourceContext })
    store.setState(runtimeSettingsState('focused-runtime'))

    sourceResult.resolve([{ ...card(1), title: 'Source card' }])
    await expect(request).resolves.toMatchObject([{ id: 1, title: 'Source card' }])
    expect(businessmapListCards).toHaveBeenCalledWith(sourceContext, 'assigned', 30, null, null)
    expect(Object.values(store.getState().businessmapSearchCache)).toHaveLength(1)
    expect(
      store.getState().businessmapSearchCache['site-1::all::list::assigned::30']
    ).toBeUndefined()
  })

  it('keeps isolated status failures from mutating the focused Businessmap settings state', async () => {
    const store = createTestStore()
    const focusedStatus: BusinessmapConnectionStatus = {
      connected: true,
      viewer: { displayName: 'Ada', subdomain: 'focused' },
      selectedSiteId: 'site-1'
    }
    store.setState({
      businessmapStatus: focusedStatus,
      businessmapStatusChecked: true,
      businessmapStatusContextKey: 'local#0'
    })
    businessmapReadStatus.mockRejectedValueOnce(new Error('Source runtime credentials unavailable'))

    await expect(
      store.getState().readBusinessmapStatus(businessmapSourceContext('source-runtime'))
    ).rejects.toThrow('Source runtime credentials unavailable')

    expect(store.getState().businessmapStatus).toEqual(focusedStatus)
    expect(store.getState().businessmapStatusContextKey).toBe('local#0')
    expect(businessmapStatus).not.toHaveBeenCalled()
  })

  it('returns a failed Businessmap connect result when the active runtime changes before completion', async () => {
    const store = createTestStore()
    const connectResult = deferred<{ ok: true; viewer: BusinessmapViewer }>()
    businessmapConnect.mockReturnValueOnce(connectResult.promise)

    const request = store.getState().connectBusinessmap({
      subdomain: 'acme',
      apiKey: 'token'
    })
    store.setState(runtimeSettingsState('runtime-1'))

    connectResult.resolve({ ok: true, viewer: { displayName: 'Ada', subdomain: 'acme' } })
    await expect(request).resolves.toEqual({
      ok: false,
      error: 'Businessmap connection was superseded by a newer request.'
    })
    expect(store.getState().businessmapStatus.connected).toBe(false)
    expect(store.getState().businessmapStatusContextKey).toBeNull()
  })

  it('does not run a stale test follow-up status check after the active runtime changes', async () => {
    const store = createTestStore()
    const testResult = deferred<{ ok: true; viewer: BusinessmapViewer }>()
    businessmapTestConnection.mockReturnValueOnce(testResult.promise)

    const request = store.getState().testBusinessmapConnection()
    store.setState(runtimeSettingsState('runtime-1'))

    testResult.resolve({ ok: true, viewer: { displayName: 'Ada', subdomain: 'acme' } })
    await request
    expect(businessmapStatus).not.toHaveBeenCalled()
  })

  it('does not clear or refresh stale disconnect results after the active runtime changes', async () => {
    const store = createTestStore()
    const disconnectResult = deferred<void>()
    businessmapDisconnect.mockReturnValueOnce(disconnectResult.promise)

    const request = store.getState().disconnectBusinessmap()
    store.setState(runtimeSettingsState('runtime-1'))

    disconnectResult.resolve()
    await request
    expect(businessmapStatus).not.toHaveBeenCalled()
  })

  it('publishes a connection revision after disconnecting the active Businessmap source', async () => {
    const store = createTestStore()
    businessmapDisconnect.mockResolvedValueOnce(undefined)
    businessmapStatus.mockResolvedValueOnce({ connected: false, viewer: null })

    await store.getState().disconnectBusinessmap()

    expect(store.getState().businessmapConnectionRevisions['local#0']).toBe(1)
  })
})

describe('createBusinessmapSlice credential errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('serves fresh Businessmap cache without reading credentials', async () => {
    const store = createTestStore()
    store.setState({
      businessmapStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' },
      businessmapSearchCache: {
        'site-1::all::list::assigned::30': { data: [card(1)], fetchedAt: Date.now() }
      }
    })

    await expect(store.getState().listBusinessmapCards('assigned', 30)).resolves.toMatchObject([
      { id: 1 }
    ])

    expect(businessmapListCards).not.toHaveBeenCalled()
  })

  it('publishes source-scoped auth changes without clearing focused settings status', async () => {
    const store = createTestStore()
    const source = businessmapSourceContext('remote-runtime')
    const focusedStatus = status('focused')
    store.setState({ businessmapStatus: focusedStatus })
    businessmapSearchCards.mockRejectedValueOnce(new Error('Error 401: Unauthorized'))

    await expect(
      store.getState().searchBusinessmapCards('doing', 12, { sourceContext: source })
    ).resolves.toEqual([])

    const revisionKey = getProviderRuntimeContextKey(getTaskSourceRuntimeSettings(source))
    expect(store.getState().businessmapConnectionRevisions[revisionKey]).toBe(1)
    expect(store.getState().businessmapStatus).toEqual(focusedStatus)
  })

  it('returns an empty list on decrypt errors and refreshes connection status', async () => {
    const store = createTestStore()
    const error = new Error(credentialDecryptionMessage('Businessmap'))
    store.setState({
      businessmapStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    businessmapStatus.mockResolvedValue({ connected: true, viewer: null, selectedSiteId: 'site-1' })
    businessmapSearchCards.mockRejectedValueOnce(error)

    await expect(store.getState().searchBusinessmapCards('doing', 30)).resolves.toEqual([])
    await vi.waitFor(() => {
      expect(businessmapStatus).toHaveBeenCalled()
    })
  })

  it('surfaces endpoint-level forbidden errors without disconnecting Businessmap', async () => {
    const store = createTestStore()
    store.setState({
      businessmapStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    businessmapListCards.mockRejectedValueOnce(new Error('Forbidden'))

    await expect(store.getState().listBusinessmapCards('assigned', 30)).rejects.toThrow('Forbidden')

    expect(store.getState().businessmapStatus.connected).toBe(true)
  })

  it('re-throws non-auth card-read failures instead of returning null', async () => {
    const store = createTestStore()
    businessmapGetCard.mockRejectedValueOnce(new Error('timeout'))
    await expect(store.getState().fetchBusinessmapCard(42)).rejects.toThrow('timeout')
    businessmapGetCard.mockRejectedValueOnce(new Error('Error 401: Unauthorized'))
    await expect(store.getState().fetchBusinessmapCard(43)).resolves.toBeNull()
  })
})

describe('createBusinessmapSlice bot findings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Why: pre-mutation reads resolving after the cache clear must not repopulate stale cards.
  it('drops pre-mutation list writes that resolve after a successful card update', async () => {
    const store = createTestStore()
    store.setState({
      businessmapStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    const staleList = deferred<BusinessmapCard[]>()
    businessmapListCards.mockReturnValueOnce(staleList.promise)
    businessmapUpdateCard.mockResolvedValueOnce({ ok: true })
    const listRequest = store.getState().listBusinessmapCards('assigned', 30)
    await store.getState().updateBusinessmapCard(1, { title: 'New' })
    staleList.resolve([card(1)])
    await expect(listRequest).resolves.toMatchObject([{ id: 1 }])
    expect(store.getState().businessmapSearchCache).toEqual({})
  })

  // Why: finally on a separate promise leaves an unowned rejection when boards fail.
  it('owns the boards cleanup rejection on the returned promise', async () => {
    const store = createTestStore()
    businessmapListBoards.mockRejectedValueOnce(new Error('boards down'))
    await expect(store.getState().listBusinessmapBoards()).rejects.toThrow('boards down')
  })

  // Why: two abortable searches on one key must keep the newest result, not the last to land.
  it('keeps the newest abortable search result when an older request lands last', async () => {
    const store = createTestStore()
    const first = deferred<BusinessmapCard[]>()
    const second = deferred<BusinessmapCard[]>()
    businessmapSearchCards.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstRequest = store
      .getState()
      .searchBusinessmapCards('doing', 30, { signal: firstController.signal })
    const secondRequest = store
      .getState()
      .searchBusinessmapCards('doing', 30, { signal: secondController.signal })
    second.resolve([{ ...card(2), title: 'Newer' }])
    await secondRequest
    first.resolve([{ ...card(1), title: 'Older' }])
    await firstRequest
    expect(
      store.getState().businessmapSearchCache['default::all::doing::30']?.data?.[0]?.title
    ).toBe('Newer')
  })

  // Why: an explicit source runtime must never read the focused site selection.
  it('resolves no site for explicit source reads without a siteId', async () => {
    const store = createTestStore()
    store.setState({
      businessmapStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    const source = businessmapSourceContext('remote-runtime')
    businessmapSearchCards.mockResolvedValueOnce([])
    await store.getState().searchBusinessmapCards('doing', 12, { sourceContext: source })
    expect(businessmapSearchCards).toHaveBeenCalledWith(
      source,
      'doing',
      12,
      null,
      null,
      undefined
    )
  })

  // Why: viewer subdomain and same-length site changes must still publish a revision.
  it('publishes a revision when only the viewer subdomain changes', async () => {
    const store = createTestStore()
    store.setState({
      businessmapStatus: status('old'),
      businessmapStatusChecked: true,
      businessmapStatusContextKey: 'local#0'
    })
    businessmapStatus.mockResolvedValueOnce(status('new'))
    await store.getState().checkBusinessmapConnection()
    expect(store.getState().businessmapConnectionRevisions['local#0']).toBe(1)
    expect(store.getState().businessmapStatus.viewer?.subdomain).toBe('new')
  })

  // Why: disconnect must clear caches even when the follow-up status read fails.
  it('clears caches and marks unchecked when the post-disconnect status read fails', async () => {
    const store = createTestStore()
    store.setState({
      businessmapStatus: status('acme'),
      businessmapSearchCache: {
        'site-1::all::list::assigned::30': { data: [card(1)], fetchedAt: Date.now() }
      }
    })
    businessmapDisconnect.mockResolvedValueOnce(undefined)
    businessmapStatus.mockRejectedValueOnce(new Error('status down'))
    await store.getState().disconnectBusinessmap()
    expect(store.getState().businessmapSearchCache).toEqual({})
    expect(store.getState().businessmapStatus.connected).toBe(false)
    expect(store.getState().businessmapStatusChecked).toBe(true)
  })
})
