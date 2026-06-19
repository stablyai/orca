import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { GlpiConnectionStatus, GlpiTicket, GlpiViewer } from '../../../../shared/types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { credentialDecryptionMessage } from '../../../../shared/integration-credential-errors'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { createGlpiSlice } from './glpi'

// Why: default-scope cache keys are namespaced by the runtime context key so
// cached data can't bleed across runtime environments.
const defaultScope = getProviderRuntimeContextKey(null)
const defaultKey = (key: string): string => `${defaultScope}::${key}`

const glpiStatus = vi.fn()
const glpiConnect = vi.fn()
const glpiDisconnect = vi.fn()
const glpiSelectServer = vi.fn()
const glpiTestConnection = vi.fn()
const glpiTicket = vi.fn()
const glpiListWorkItems = vi.fn()
const glpiFollowups = vi.fn()
const glpiAddFollowup = vi.fn()
const glpiUpdateTicket = vi.fn()
const glpiCreateTicket = vi.fn()

vi.mock('@/runtime/runtime-glpi-client', () => ({
  glpiAddFollowup: (...args: unknown[]) => glpiAddFollowup(...args),
  glpiConnect: (...args: unknown[]) => glpiConnect(...args),
  glpiCreateTicket: (...args: unknown[]) => glpiCreateTicket(...args),
  glpiDisconnect: (...args: unknown[]) => glpiDisconnect(...args),
  glpiFollowups: (...args: unknown[]) => glpiFollowups(...args),
  glpiListWorkItems: (...args: unknown[]) => glpiListWorkItems(...args),
  glpiSelectServer: (...args: unknown[]) => glpiSelectServer(...args),
  glpiStatus: (...args: unknown[]) => glpiStatus(...args),
  glpiTestConnection: (...args: unknown[]) => glpiTestConnection(...args),
  glpiTicket: (...args: unknown[]) => glpiTicket(...args),
  glpiUpdateTicket: (...args: unknown[]) => glpiUpdateTicket(...args)
}))

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        settings: null,
        ...createGlpiSlice(...a)
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

function connectionStatus(login: string): GlpiConnectionStatus {
  return {
    connected: true,
    viewer: { id: 1, login, fullName: login } as GlpiViewer,
    selectedServerId: 'srv-1'
  }
}

function ticket(id: number, overrides: Partial<GlpiTicket> = {}): GlpiTicket {
  return {
    id,
    serverId: 'srv-1',
    serverName: 'Acme GLPI',
    title: `Ticket ${id}`,
    content: '',
    status: 'new',
    urgency: 3,
    priority: 3,
    type: 'incident',
    assignees: [],
    url: `https://glpi.example.com/ticket/${id}`,
    followups: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function glpiSourceContext(environmentId: string): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'glpi',
    projectId: 'logical-project',
    hostId: `runtime:${environmentId}`,
    providerIdentity: {
      provider: 'glpi',
      serverId: 'srv-1'
    }
  }
}

describe('createGlpiSlice status and runtime context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stores the status returned by checkGlpiConnection', async () => {
    const store = createTestStore()
    glpiStatus.mockResolvedValueOnce(connectionStatus('octocat'))

    await store.getState().checkGlpiConnection()

    expect(store.getState().glpiStatus.connected).toBe(true)
    expect(store.getState().glpiStatus.viewer?.login).toBe('octocat')
    expect(store.getState().glpiStatusChecked).toBe(true)
    expect(store.getState().glpiStatusContextKey).toBe('local#0')
  })

  it('ignores stale status responses after the active runtime changes', async () => {
    const store = createTestStore()
    const localStatus = deferred<GlpiConnectionStatus>()
    const remoteStatus = deferred<GlpiConnectionStatus>()
    glpiStatus.mockReturnValueOnce(localStatus.promise).mockReturnValueOnce(remoteStatus.promise)

    const localRequest = store.getState().checkGlpiConnection()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })
    const remoteRequest = store.getState().checkGlpiConnection()

    remoteStatus.resolve(connectionStatus('remote'))
    await remoteRequest
    expect(store.getState().glpiStatus.viewer?.login).toBe('remote')
    expect(store.getState().glpiStatusContextKey).toBe('runtime:runtime-1#0')

    localStatus.resolve(connectionStatus('local'))
    await localRequest
    expect(store.getState().glpiStatus.viewer?.login).toBe('remote')
    expect(store.getState().glpiStatusContextKey).toBe('runtime:runtime-1#0')
  })
})

describe('createGlpiSlice list caching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('caches list results within the TTL so a second call does not re-hit the client', async () => {
    const store = createTestStore()
    store.setState({ glpiStatus: connectionStatus('octocat') })
    glpiListWorkItems.mockResolvedValueOnce([ticket(1)])

    await expect(store.getState().listGlpiWorkItems('assigned', 30)).resolves.toMatchObject([
      { id: 1 }
    ])
    await expect(store.getState().listGlpiWorkItems('assigned', 30)).resolves.toMatchObject([
      { id: 1 }
    ])

    expect(glpiListWorkItems).toHaveBeenCalledTimes(1)
  })

  it('treats a different filter as a separate cache entry', async () => {
    const store = createTestStore()
    store.setState({ glpiStatus: connectionStatus('octocat') })
    glpiListWorkItems
      .mockResolvedValueOnce([ticket(1, { title: 'Assigned' })])
      .mockResolvedValueOnce([ticket(2, { title: 'Created' })])

    await expect(store.getState().listGlpiWorkItems('assigned', 30)).resolves.toMatchObject([
      { title: 'Assigned' }
    ])
    await expect(store.getState().listGlpiWorkItems('created', 30)).resolves.toMatchObject([
      { title: 'Created' }
    ])

    expect(glpiListWorkItems).toHaveBeenCalledTimes(2)
    expect(Object.keys(store.getState().glpiListCache)).toHaveLength(2)
  })

  it('routes an explicit source read through that source context', async () => {
    const store = createTestStore()
    store.setState({ glpiStatus: connectionStatus('octocat') })
    const sourceContext = glpiSourceContext('source-runtime')
    const sourceResult = deferred<GlpiTicket[]>()
    glpiListWorkItems.mockReturnValueOnce(sourceResult.promise)

    const request = store.getState().listGlpiWorkItems('assigned', 30, undefined, { sourceContext })
    store.setState({ settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as never })

    sourceResult.resolve([ticket(1, { title: 'Source ticket' })])
    await expect(request).resolves.toMatchObject([{ title: 'Source ticket' }])
    expect(glpiListWorkItems).toHaveBeenCalledWith(
      sourceContext,
      'srv-1',
      'assigned',
      30,
      undefined
    )

    const scope = getTaskSourceCacheScope(sourceContext)
    expect(
      store.getState().glpiListCache[`${scope}::srv-1::list::assigned::30::{}`]?.data?.[0]?.title
    ).toBe('Source ticket')
    expect(store.getState().glpiListCache[defaultKey('srv-1::list::assigned::30')]).toBeUndefined()
  })
})

describe('createGlpiSlice ticket caching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('caches a fetched ticket by id and server', async () => {
    const store = createTestStore()
    store.setState({ glpiStatus: connectionStatus('octocat') })
    glpiTicket.mockResolvedValueOnce(ticket(7))

    await expect(store.getState().fetchGlpiTicket(7, 'srv-1')).resolves.toMatchObject({ id: 7 })
    await expect(store.getState().fetchGlpiTicket(7, 'srv-1')).resolves.toMatchObject({ id: 7 })

    expect(glpiTicket).toHaveBeenCalledTimes(1)
    expect(store.getState().glpiTicketCache[defaultKey('srv-1::7')]?.data?.id).toBe(7)
  })

  it('keeps separate cache entries per server', async () => {
    const store = createTestStore()
    store.setState({ glpiStatus: connectionStatus('octocat') })
    glpiTicket
      .mockResolvedValueOnce(ticket(7, { serverName: 'Server A' }))
      .mockResolvedValueOnce(ticket(7, { serverName: 'Server B' }))

    await store.getState().fetchGlpiTicket(7, 'srv-1')
    await store.getState().fetchGlpiTicket(7, 'srv-2')

    expect(glpiTicket).toHaveBeenCalledTimes(2)
    expect(store.getState().glpiTicketCache[defaultKey('srv-1::7')]?.data?.serverName).toBe(
      'Server A'
    )
    expect(store.getState().glpiTicketCache[defaultKey('srv-2::7')]?.data?.serverName).toBe(
      'Server B'
    )
  })
})

describe('createGlpiSlice mutation cache invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('invalidates the cached ticket after a successful followup comment', async () => {
    const store = createTestStore()
    store.setState({
      glpiStatus: connectionStatus('octocat'),
      glpiTicketCache: {
        [defaultKey('srv-1::7')]: { data: ticket(7), fetchedAt: Date.now() }
      }
    })
    glpiAddFollowup.mockResolvedValueOnce({ ok: true })

    await expect(
      store.getState().addGlpiFollowupComment(7, 'Looking into it', 'srv-1')
    ).resolves.toEqual({ ok: true })

    expect(store.getState().glpiTicketCache[defaultKey('srv-1::7')]).toBeUndefined()
  })

  it('does not invalidate the cached ticket when the followup comment fails', async () => {
    const store = createTestStore()
    store.setState({
      glpiStatus: connectionStatus('octocat'),
      glpiTicketCache: {
        [defaultKey('srv-1::7')]: { data: ticket(7), fetchedAt: Date.now() }
      }
    })
    glpiAddFollowup.mockResolvedValueOnce({ ok: false, error: 'nope' })

    await store.getState().addGlpiFollowupComment(7, 'Looking into it', 'srv-1')

    expect(store.getState().glpiTicketCache[defaultKey('srv-1::7')]).toBeDefined()
  })

  it('invalidates the cached ticket after a successful detail update', async () => {
    const store = createTestStore()
    store.setState({
      glpiStatus: connectionStatus('octocat'),
      glpiTicketCache: {
        [defaultKey('srv-1::7')]: { data: ticket(7), fetchedAt: Date.now() }
      }
    })
    glpiUpdateTicket.mockResolvedValueOnce({ ok: true })

    await expect(
      store.getState().updateGlpiTicketDetail(7, { title: 'Renamed' }, 'srv-1')
    ).resolves.toEqual({ ok: true })

    expect(store.getState().glpiTicketCache[defaultKey('srv-1::7')]).toBeUndefined()
  })

  it('invalidates the list cache after creating a ticket', async () => {
    const store = createTestStore()
    store.setState({
      glpiStatus: connectionStatus('octocat'),
      glpiListCache: {
        [defaultKey('srv-1::list::assigned::30')]: { data: [ticket(1)], fetchedAt: Date.now() }
      }
    })
    glpiCreateTicket.mockResolvedValueOnce({ ok: true, id: 9, url: 'https://glpi.example.com/9' })

    await expect(store.getState().createGlpiTicket({ title: 'New ticket' })).resolves.toMatchObject(
      { ok: true, id: 9 }
    )

    expect(store.getState().glpiListCache[defaultKey('srv-1::list::assigned::30')]).toBeUndefined()
  })
})

describe('createGlpiSlice credential errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('serves a fresh ticket cache without reading credentials', async () => {
    const store = createTestStore()
    store.setState({
      glpiStatus: connectionStatus('octocat'),
      glpiTicketCache: {
        [defaultKey('srv-1::7')]: { data: ticket(7), fetchedAt: Date.now() }
      }
    })

    await expect(store.getState().fetchGlpiTicket(7, 'srv-1')).resolves.toMatchObject({ id: 7 })

    expect(glpiTicket).not.toHaveBeenCalled()
  })

  it('returns the fallback and surfaces the credential error via status refresh on decrypt errors', async () => {
    const store = createTestStore()
    const error = new Error(credentialDecryptionMessage('GLPI'))
    store.setState({ glpiStatus: connectionStatus('octocat') })
    glpiTicket.mockRejectedValueOnce(error)
    glpiStatus.mockResolvedValue({
      ...connectionStatus('octocat'),
      credentialError: error.message
    })

    await expect(store.getState().fetchGlpiTicket(7, 'srv-1')).resolves.toBeNull()
    expect(glpiStatus).toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(store.getState().glpiStatus.credentialError).toBe(error.message)
    })
  })
})
