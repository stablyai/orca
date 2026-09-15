import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  redmineConnect,
  redmineDisconnect,
  redmineGetIssue,
  redmineListIssues,
  redmineStatus,
  redmineTestConnection
} from '@/runtime/runtime-redmine-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { createRedmineActions } from './redmine-slice-actions'
import type { AppState } from '../../types'

vi.mock('@/runtime/runtime-redmine-client', () => ({
  redmineConnect: vi.fn(),
  redmineDisconnect: vi.fn(),
  redmineGetIssue: vi.fn(),
  redmineListIssues: vi.fn(),
  redmineStatus: vi.fn(),
  redmineTestConnection: vi.fn()
}))

vi.mock('@/lib/provider-runtime-context', () => ({
  getProviderRuntimeContextKey: vi.fn(() => 'ctx:local')
}))

const redmineStatusMock = vi.mocked(redmineStatus)
const redmineConnectMock = vi.mocked(redmineConnect)
const redmineDisconnectMock = vi.mocked(redmineDisconnect)
const redmineListIssuesMock = vi.mocked(redmineListIssues)
const redmineGetIssueMock = vi.mocked(redmineGetIssue)
const redmineTestConnectionMock = vi.mocked(redmineTestConnection)
const getProviderRuntimeContextKeyMock = vi.mocked(getProviderRuntimeContextKey)

function emptyStatus() {
  return { connected: false, activeSite: null, selectedSiteId: null, viewer: null, error: null }
}

type Setter = (patch: unknown) => void

let state!: AppState
let actions!: ReturnType<typeof createRedmineActions>
let set!: Setter

function makeState(): AppState {
  return {
    settings: {},
    redmineStatus: emptyStatus(),
    redmineStatusChecked: false,
    redmineStatusContextKey: null,
    redmineIssueCache: {},
    redmineListCache: {},
    redmineListInvalidationToken: { scope: '', version: 0 }
  } as unknown as AppState
}

function install() {
  state = makeState()
  const setter: Setter = (patch) => {
    const next = typeof patch === 'function' ? patch(state) : patch
    Object.assign(state, next)
  }
  const getter = () => state
  actions = createRedmineActions(
    setter as unknown as Parameters<typeof createRedmineActions>[0],
    getter as unknown as Parameters<typeof createRedmineActions>[1]
  )
  Object.assign(state, actions)
  set = setter
}

beforeEach(() => {
  vi.clearAllMocks()
  getProviderRuntimeContextKeyMock.mockReturnValue('ctx:local')
  install()
})

const site = {
  id: 'https://rm.example.com',
  siteUrl: 'https://rm.example.com',
  displayName: 'rm',
  hasToken: true
}

describe('checkRedmineConnection', () => {
  it('probes once and records the checked flag', async () => {
    redmineStatusMock.mockResolvedValue(emptyStatus())
    await actions.checkRedmineConnection()
    expect(redmineStatusMock).toHaveBeenCalledTimes(1)
    expect(state.redmineStatusChecked).toBe(true)
  })

  it('skips the probe when already checked and force is not passed', async () => {
    set({ redmineStatusChecked: true })
    await actions.checkRedmineConnection()
    expect(redmineStatusMock).not.toHaveBeenCalled()
  })

  it('reprobes when force is passed', async () => {
    redmineStatusMock.mockResolvedValue(emptyStatus())
    await actions.checkRedmineConnection(true)
    expect(redmineStatusMock).toHaveBeenCalledTimes(1)
  })

  it('clears caches only when the status scope signature changes', async () => {
    set({
      redmineStatus: { ...emptyStatus(), connected: true, activeSite: site },
      redmineListCache: { k: { data: { items: [], totalCount: 0 }, fetchedAt: Date.now() } }
    })
    redmineStatusMock.mockResolvedValue({ ...emptyStatus(), connected: false })
    await actions.checkRedmineConnection()
    expect(state.redmineListCache).toEqual({})
  })
})

describe('connectRedmine', () => {
  it('persists status and clears caches on success', async () => {
    redmineConnectMock.mockResolvedValue({
      ok: true,
      site,
      viewer: { id: 1, name: 'Ada', login: 'ada' }
    })
    redmineStatusMock.mockResolvedValue({ ...emptyStatus(), connected: true, activeSite: site })
    set({ redmineListCache: { k: { data: { items: [], totalCount: 0 }, fetchedAt: Date.now() } } })

    const result = await actions.connectRedmine({ siteUrl: site.siteUrl, apiKey: 'secret' })

    expect(result.ok).toBe(true)
    expect(redmineConnectMock).toHaveBeenCalledWith(expect.anything(), {
      siteUrl: site.siteUrl,
      apiKey: 'secret'
    })
    expect(state.redmineStatus?.connected).toBe(true)
    expect(state.redmineStatusChecked).toBe(true)
    expect(state.redmineStatusContextKey).toBe('ctx:local')
    expect(state.redmineListCache).toEqual({})
  })

  it('returns the failure without touching status', async () => {
    redmineConnectMock.mockResolvedValue({
      ok: false,
      error: { type: 'auth', message: 'bad key' }
    })
    const result = await actions.connectRedmine({ siteUrl: site.siteUrl, apiKey: 'nope' })
    expect(result.ok).toBe(false)
    expect(state.redmineStatus?.connected).toBe(false)
    expect(state.redmineStatusChecked).toBe(false)
  })
})

describe('disconnectRedmine', () => {
  it('resets status and clears caches', async () => {
    set({
      redmineStatus: { ...emptyStatus(), connected: true, activeSite: site },
      redmineListCache: { k: { data: { items: [], totalCount: 0 }, fetchedAt: Date.now() } }
    })
    redmineDisconnectMock.mockResolvedValue(undefined)
    await actions.disconnectRedmine()
    expect(redmineDisconnectMock).toHaveBeenCalledWith(expect.anything(), site.id)
    expect(state.redmineStatus?.connected).toBe(false)
    expect(state.redmineListCache).toEqual({})
    expect(state.redmineStatusChecked).toBe(true)
  })
})

describe('listRedmineIssues', () => {
  it('fetches and caches when no fresh entry exists', async () => {
    set({ redmineStatusChecked: true })
    redmineListIssuesMock.mockResolvedValue({ items: [], totalCount: 0 })
    const result = await actions.listRedmineIssues({ scope: 'assigned' })
    expect(result).toEqual({ items: [], totalCount: 0 })
    expect(redmineListIssuesMock).toHaveBeenCalledWith(expect.anything(), { scope: 'assigned' })
    expect(Object.keys(state.redmineListCache).length).toBe(1)
  })

  it('reuses a fresh cache entry without refetching', async () => {
    set({ redmineStatusChecked: true })
    redmineListIssuesMock.mockResolvedValue({ items: [], totalCount: 0 })
    await actions.listRedmineIssues({ scope: 'assigned' })
    redmineListIssuesMock.mockClear()
    const second = await actions.listRedmineIssues({ scope: 'assigned' })
    expect(second).toEqual({ items: [], totalCount: 0 })
    expect(redmineListIssuesMock).not.toHaveBeenCalled()
  })

  it('refetches when force is passed', async () => {
    set({ redmineStatusChecked: true })
    redmineListIssuesMock.mockResolvedValue({ items: [], totalCount: 0 })
    await actions.listRedmineIssues({ scope: 'assigned' })
    redmineListIssuesMock.mockClear()
    await actions.listRedmineIssues({ scope: 'assigned' }, { force: true })
    expect(redmineListIssuesMock).toHaveBeenCalledTimes(1)
  })
})

describe('getRedmineIssue', () => {
  it('fetches and caches an issue', async () => {
    const issue = {
      id: 1,
      subject: 'Fix',
      project: { id: 1, name: 'P' },
      tracker: { id: 1, name: 'Bug' },
      status: { id: 1, name: 'New' },
      priority: { id: 1, name: 'Normal' },
      author: { id: 1, name: 'Ada', login: 'ada' },
      assignedTo: null,
      description: null,
      startDate: null,
      dueDate: null,
      doneRatio: 0,
      estimatedHours: null,
      spentHours: null,
      createdOn: '2026-01-01T00:00:00Z',
      updatedOn: '2026-01-01T00:00:00Z',
      closedOn: null,
      customFields: [],
      url: 'https://rm.example.com/issues/1'
    }
    redmineGetIssueMock.mockResolvedValue({ issue })
    const result = await actions.getRedmineIssue(1)
    expect(result.issue?.id).toBe(1)
    redmineGetIssueMock.mockClear()
    await actions.getRedmineIssue(1)
    expect(redmineGetIssueMock).not.toHaveBeenCalled()
  })
})

describe('testRedmineConnection / invalidateRedmineIssueLists', () => {
  it('forwards a test call to the runtime client', async () => {
    redmineTestConnectionMock.mockResolvedValue({
      ok: true,
      user: { id: 1, name: 'Ada', login: 'ada' }
    })
    const result = await actions.testRedmineConnection({ siteUrl: site.siteUrl, apiKey: 'k' })
    expect(redmineTestConnection).toHaveBeenCalledWith(expect.anything(), {
      siteUrl: site.siteUrl,
      apiKey: 'k'
    })
    expect(result.ok).toBe(true)
  })

  it('bumps the invalidation token and clears the list cache', () => {
    set({ redmineListCache: { k: { data: { items: [], totalCount: 0 }, fetchedAt: Date.now() } } })
    actions.invalidateRedmineIssueLists()
    expect(state.redmineListInvalidationToken.version).toBe(1)
    expect(state.redmineListInvalidationToken.scope).toBe('1')
    expect(state.redmineListCache).toEqual({})
  })
})
