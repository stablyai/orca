import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HulyComment,
  HulyConnectionStatus,
  HulyIssue,
  HulyProjectSummary
} from '../../../../shared/types'
import { createTestStore } from './store-test-helpers'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'

function hulyCacheScopeForTest(sourceContext: {
  projectId: string
  hostId?: ExecutionHostId | null
  projectHostSetupId?: string | null
  repoId?: string | null
  providerIdentity?: null
}): string {
  return getTaskSourceCacheScope({
    provider: 'huly',
    projectId: sourceContext.projectId,
    hostId: sourceContext.hostId ?? LOCAL_EXECUTION_HOST_ID,
    projectHostSetupId: sourceContext.projectHostSetupId ?? null,
    repoId: sourceContext.repoId ?? null,
    providerIdentity: null
  })
}

const hulyStatus = vi.fn()
const hulyPreflight = vi.fn()
const hulySearchIssues = vi.fn()
const hulyListIssues = vi.fn()
const hulyGetIssue = vi.fn()
const hulyListTeams = vi.fn()
const hulyListProjects = vi.fn()
const hulyGetProject = vi.fn()
const hulyConnect = vi.fn()
const hulyDisconnect = vi.fn()
const hulySelectConnection = vi.fn()
const hulyUpdateIssue = vi.fn()
const hulyCreateIssue = vi.fn()
const hulyAddComment = vi.fn()
const hulyListComments = vi.fn()
const hulyCreateProject = vi.fn()
const hulyListProjectIssues = vi.fn()
const hulyTeamMembers = vi.fn()
const hulyTeamStates = vi.fn()
const hulyTeamLabels = vi.fn()

vi.mock('../../runtime/runtime-huly-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    hulyStatus: (...args: unknown[]) => hulyStatus(...args),
    hulyPreflight: (...args: unknown[]) => hulyPreflight(...args),
    hulySearchIssues: (...args: unknown[]) => hulySearchIssues(...args),
    hulyListIssues: (...args: unknown[]) => hulyListIssues(...args),
    hulyGetIssue: (...args: unknown[]) => hulyGetIssue(...args),
    hulyListTeams: (...args: unknown[]) => hulyListTeams(...args),
    hulyListProjects: (...args: unknown[]) => hulyListProjects(...args),
    hulyGetProject: (...args: unknown[]) => hulyGetProject(...args),
    hulyConnect: (...args: unknown[]) => hulyConnect(...args),
    hulyDisconnect: (...args: unknown[]) => hulyDisconnect(...args),
    hulySelectConnection: (...args: unknown[]) => hulySelectConnection(...args),
    hulyUpdateIssue: (...args: unknown[]) => hulyUpdateIssue(...args),
    hulyCreateIssue: (...args: unknown[]) => hulyCreateIssue(...args),
    hulyAddComment: (...args: unknown[]) => hulyAddComment(...args),
    hulyListComments: (...args: unknown[]) => hulyListComments(...args),
    hulyCreateProject: (...args: unknown[]) => hulyCreateProject(...args),
    hulyListProjectIssues: (...args: unknown[]) => hulyListProjectIssues(...args),
    hulyTeamMembers: (...args: unknown[]) => hulyTeamMembers(...args),
    hulyTeamStates: (...args: unknown[]) => hulyTeamStates(...args),
    hulyTeamLabels: (...args: unknown[]) => hulyTeamLabels(...args)
  }
})

vi.mock('../../lib/provider-runtime-context', () => ({
  getProviderRuntimeContextKey: () => 'local'
}))

const disconnected: HulyConnectionStatus = {
  connected: false,
  viewer: null,
  connections: [],
  activeConnectionId: null,
  selectedConnectionId: null,
  cliInstalled: false,
  cliAuthenticated: false
}

const connected: HulyConnectionStatus = {
  connected: true,
  viewer: { displayName: 'me', email: 'me@example.com' },
  connections: [
    {
      id: 'huly-1',
      name: 'My Huly',
      url: 'https://huly.app',
      workspace: 'main',
      email: 'me@example.com'
    }
  ],
  activeConnectionId: 'huly-1',
  selectedConnectionId: 'huly-1',
  cliInstalled: true,
  cliAuthenticated: true,
  cliVersion: '1.2.3'
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createHulySlice', () => {
  it('starts with a disconnected status', () => {
    const store = createTestStore()
    expect(store.getState().hulyStatus.connected).toBe(false)
    expect(store.getState().hulyStatusChecked).toBe(false)
    expect(store.getState().hulyStatusContextKey).toBeNull()
  })

  it('checkHulyConnection writes the resolved status and marks the context key', async () => {
    hulyStatus.mockResolvedValueOnce(connected)
    const store = createTestStore()
    await store.getState().checkHulyConnection(true)
    expect(store.getState().hulyStatus.connected).toBe(true)
    expect(store.getState().hulyStatusChecked).toBe(true)
    expect(store.getState().hulyStatusContextKey).toBe('local')
    expect(hulyStatus).toHaveBeenCalledTimes(1)
  })

  it('checkHulyConnection is a no-op when context matches and not forced', async () => {
    hulyStatus.mockResolvedValueOnce(connected)
    const store = createTestStore()
    await store.getState().checkHulyConnection(true)
    hulyStatus.mockClear()
    await store.getState().checkHulyConnection()
    expect(hulyStatus).not.toHaveBeenCalled()
  })

  it('checkHulyConnection resets the status on failure', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hulyStatus.mockResolvedValueOnce(connected)
    hulyStatus.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    await store.getState().checkHulyConnection(true)
    expect(store.getState().hulyStatus.connected).toBe(true)
    await store.getState().checkHulyConnection(true)
    expect(store.getState().hulyStatus.connected).toBe(false)
    expect(store.getState().hulyStatus.connections).toEqual([])
    expect(store.getState().hulyStatusChecked).toBe(true)
    errSpy.mockRestore()
  })

  it('refreshHulyPreflight copies the preflight result into the slice', async () => {
    hulyPreflight.mockResolvedValueOnce({
      installed: true,
      authenticated: true,
      cliVersion: '1.2.3'
    })
    const store = createTestStore()
    await store.getState().refreshHulyPreflight()
    expect(store.getState().hulyPreflightStatus).toEqual({
      installed: true,
      authenticated: true,
      cliVersion: '1.2.3'
    })
    expect(hulyPreflight).toHaveBeenCalledTimes(1)
  })

  it('refreshHulyPreflight swallows errors', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hulyPreflight.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    await expect(store.getState().refreshHulyPreflight()).resolves.toBeUndefined()
    errSpy.mockRestore()
  })

  it('connectHuly success path returns the refreshed viewer', async () => {
    hulyConnect.mockResolvedValueOnce({
      ok: true,
      viewer: { displayName: 'me', email: 'me@example.com' }
    })
    hulyStatus.mockResolvedValueOnce(connected)
    hulyPreflight.mockResolvedValueOnce({
      installed: true,
      authenticated: true,
      cliVersion: '1.2.3'
    })
    const store = createTestStore()
    const result = await store.getState().connectHuly({
      name: 'My Huly',
      url: 'https://huly.app',
      workspace: 'main',
      email: 'me@example.com',
      secret: 'token-xyz'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.viewer.email).toBe('me@example.com')
    }
    expect(store.getState().hulyStatus.connected).toBe(true)
    expect(store.getState().hulyPreflightStatus.installed).toBe(true)
  })

  it('connectHuly failure path surfaces the error without mutating status', async () => {
    hulyConnect.mockResolvedValueOnce({ ok: false, error: 'Invalid token' })
    const store = createTestStore()
    const result = await store.getState().connectHuly({
      name: 'My Huly',
      url: 'https://huly.app',
      workspace: 'main',
      email: 'me@example.com',
      secret: 'bad'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Invalid token')
    }
    expect(store.getState().hulyStatus.connected).toBe(false)
  })

  it('connectHuly returns ok:false when status refresh drops the connection', async () => {
    hulyConnect.mockResolvedValueOnce({ ok: true, viewer: { displayName: 'me' } })
    hulyStatus.mockResolvedValueOnce(disconnected)
    hulyPreflight.mockResolvedValueOnce({ installed: true, authenticated: false })
    const store = createTestStore()
    const result = await store.getState().connectHuly({
      name: 'My Huly',
      url: 'https://huly.app',
      workspace: 'main',
      email: 'me@example.com',
      secret: 'token-xyz'
    })
    expect(result.ok).toBe(false)
  })

  it('disconnectHuly routes through the runtime client and resets caches', async () => {
    hulyDisconnect.mockResolvedValueOnce(undefined)
    hulyStatus.mockResolvedValueOnce(disconnected)
    const store = createTestStore()
    store.setState({
      hulyIssueCache: {
        'local::huly-1::CORE-1': { data: {} as never, fetchedAt: Date.now() }
      }
    })
    await store.getState().disconnectHuly('huly-1')
    expect(hulyDisconnect).toHaveBeenCalledWith(undefined, 'huly-1')
    expect(store.getState().hulyStatus.connected).toBe(false)
    expect(store.getState().hulyIssueCache).toEqual({})
  })

  it('selectHulyConnection routes through the runtime client and resets caches', async () => {
    hulySelectConnection.mockResolvedValueOnce(connected)
    hulyStatus.mockResolvedValueOnce(connected)
    const store = createTestStore()
    store.setState({
      hulyCommentCache: {
        'local::huly-1::CORE-1': { data: [], fetchedAt: Date.now() }
      }
    })
    await store.getState().selectHulyConnection('huly-2')
    expect(hulySelectConnection).toHaveBeenCalledWith(undefined, 'huly-2')
    expect(store.getState().hulyStatus.connected).toBe(true)
    expect(store.getState().hulyCommentCache).toEqual({})
  })

  it('searchHulyIssues forwards query, limit, and active connectionId', async () => {
    hulySearchIssues.mockResolvedValueOnce([])
    const store = createTestStore()
    store.setState({ hulyStatus: connected })
    await store.getState().searchHulyIssues('login', 25)
    expect(hulySearchIssues).toHaveBeenCalledWith(undefined, 'login', 25, 'huly-1')
  })

  it('listHulyIssues forwards filter, limit, and active connectionId', async () => {
    hulyListIssues.mockResolvedValueOnce([])
    const store = createTestStore()
    store.setState({ hulyStatus: connected })
    await store.getState().listHulyIssues({ filter: 'assigned', limit: 10 })
    expect(hulyListIssues).toHaveBeenCalledWith(undefined, 'assigned', 10, 'huly-1')
  })

  it('listHulyIssues caches successful results and serves them on repeat calls', async () => {
    const issue: HulyIssue = {
      id: 'CORE-1',
      connectionId: 'huly-1',
      identifier: 'CORE-1',
      title: 'Auth refactor',
      url: 'https://huly.app/CORE-1',
      state: { id: 's1', name: 'Todo', type: 'open' },
      team: { id: 'team-1', name: 'Core', key: 'CORE' },
      labels: [],
      labelIds: [],
      priority: 0,
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    hulyListIssues.mockResolvedValueOnce([issue])
    const store = createTestStore()
    store.setState({ hulyStatus: connected })
    const first = await store.getState().listHulyIssues({
      filter: 'all',
      limit: 50,
      connectionId: 'huly-1'
    })
    expect(first).toEqual([issue])
    hulyListIssues.mockClear()
    const second = await store.getState().listHulyIssues({
      filter: 'all',
      limit: 50,
      connectionId: 'huly-1'
    })
    expect(second).toEqual([issue])
    expect(hulyListIssues).not.toHaveBeenCalled()
  })

  it('listHulyIssues returns an empty array on error instead of throwing', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hulyListIssues.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    const result = await store.getState().listHulyIssues({ filter: 'all', limit: 5 })
    expect(result).toEqual([])
    errSpy.mockRestore()
  })

  it('fetchHulyIssue caches successful results and returns them on subsequent calls', async () => {
    const issue: HulyIssue = {
      id: 'CORE-1',
      connectionId: 'huly-1',
      identifier: 'CORE-1',
      title: 'Auth refactor',
      url: 'https://huly.app/CORE-1',
      state: { id: 's1', name: 'Todo', type: 'open' },
      team: { id: 'team-1', name: 'Core', key: 'CORE' },
      labels: [],
      labelIds: [],
      priority: 0,
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    hulyGetIssue.mockResolvedValueOnce(issue)
    const store = createTestStore()
    store.setState({ hulyStatus: connected })
    const first = await store.getState().fetchHulyIssue('CORE-1', 'huly-1')
    expect(first?.id).toBe('CORE-1')
    hulyGetIssue.mockClear()
    const second = await store.getState().fetchHulyIssue('CORE-1', 'huly-1')
    expect(second?.id).toBe('CORE-1')
    expect(hulyGetIssue).not.toHaveBeenCalled()
  })

  it('fetchHulyIssue returns null when the runtime client throws', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hulyGetIssue.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    const result = await store.getState().fetchHulyIssue('CORE-1', 'huly-1')
    expect(result).toBeNull()
    errSpy.mockRestore()
  })

  it('createHulyIssue invalidates the issue list cache on success', async () => {
    hulyCreateIssue.mockResolvedValueOnce({
      ok: true,
      issue: {
        id: 'CORE-2',
        connectionId: 'huly-1',
        identifier: 'CORE-2',
        title: 'New',
        url: 'https://huly.app/CORE-2',
        state: { id: 's1', name: 'Todo', type: 'open' },
        team: { id: 'team-1', name: 'Core', key: 'CORE' },
        labels: [],
        labelIds: [],
        priority: 0,
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    })
    const store = createTestStore()
    const sourceContext = {
      kind: 'task-source' as const,
      provider: 'huly' as const,
      projectId: 'p',
      hostId: LOCAL_EXECUTION_HOST_ID as ExecutionHostId,
      projectHostSetupId: null,
      repoId: null,
      providerIdentity: null
    }
    const scope = hulyCacheScopeForTest(sourceContext)
    store.setState({
      hulyListCache: {
        [`${scope}::huly-1::all::50`]: { data: [], fetchedAt: Date.now() },
        [`${scope}::huly-2::all::50`]: { data: [], fetchedAt: Date.now() }
      }
    })
    const before = store.getState().hulyListInvalidationToken.version
    await store.getState().createHulyIssue(
      {
        teamId: 'team-1',
        title: 'New',
        connectionId: 'huly-1'
      },
      { sourceContext }
    )
    const after = store.getState().hulyListInvalidationToken.version
    expect(after).toBeGreaterThan(before)
    expect(store.getState().hulyListCache).toEqual({})
  })

  it('createHulyIssue returns ok:false when the runtime call throws', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hulyCreateIssue.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    const result = await store.getState().createHulyIssue({
      teamId: 'team-1',
      title: 'New',
      connectionId: 'huly-1'
    })
    expect(result.ok).toBe(false)
    errSpy.mockRestore()
  })

  it('createHulyIssue does not invalidate on failure', async () => {
    hulyCreateIssue.mockResolvedValueOnce({ ok: false, error: 'permission denied' })
    const store = createTestStore()
    const before = store.getState().hulyListInvalidationToken.version
    await store.getState().createHulyIssue({
      teamId: 'team-1',
      title: 'New',
      connectionId: 'huly-1'
    })
    const after = store.getState().hulyListInvalidationToken.version
    expect(after).toBe(before)
  })

  it('updateHulyIssue invalidates lists and forwards the active connectionId', async () => {
    hulyUpdateIssue.mockResolvedValueOnce({ ok: true })
    const store = createTestStore()
    store.setState({ hulyStatus: connected })
    const before = store.getState().hulyListInvalidationToken.version
    const result = await store.getState().updateHulyIssue('CORE-1', { title: 'New title' })
    expect(result.ok).toBe(true)
    expect(hulyUpdateIssue).toHaveBeenCalledWith(
      undefined,
      'CORE-1',
      { title: 'New title' },
      'huly-1'
    )
    expect(store.getState().hulyListInvalidationToken.version).toBeGreaterThan(before)
  })

  it('updateHulyIssue returns ok:false when the runtime call throws', async () => {
    hulyUpdateIssue.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    const result = await store.getState().updateHulyIssue('CORE-1', { title: 'New title' })
    expect(result.ok).toBe(false)
  })

  it('addHulyComment forwards the call and clears the matching comment cache entry', async () => {
    const comment: HulyComment = {
      id: 'c-1',
      body: 'nice',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
    hulyAddComment.mockResolvedValueOnce({ ok: true, comment })
    const store = createTestStore()
    store.setState({ hulyStatus: connected })
    const sourceContext = {
      kind: 'task-source' as const,
      provider: 'huly' as const,
      projectId: 'p',
      hostId: LOCAL_EXECUTION_HOST_ID as ExecutionHostId,
      projectHostSetupId: null,
      repoId: null,
      providerIdentity: null
    }
    const scope = hulyCacheScopeForTest(sourceContext)
    store.setState({
      hulyCommentCache: {
        [`${scope}::huly-1::CORE-1`]: { data: [], fetchedAt: Date.now() }
      }
    })
    const result = await store.getState().addHulyComment('CORE-1', 'nice', { sourceContext })
    expect(result.ok).toBe(true)
    expect(hulyAddComment).toHaveBeenCalledWith(sourceContext, 'CORE-1', 'nice', 'huly-1')
    expect(store.getState().hulyCommentCache).toEqual({})
  })

  it('addHulyComment returns ok:false when the runtime call throws', async () => {
    hulyAddComment.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    const result = await store.getState().addHulyComment('CORE-1', 'nice', undefined)
    expect(result.ok).toBe(false)
  })

  it('listHulyComments caches successful results and serves them on repeat calls', async () => {
    const comment: HulyComment = {
      id: 'c-1',
      body: 'first',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
    hulyListComments.mockResolvedValueOnce([comment])
    const store = createTestStore()
    store.setState({ hulyStatus: connected })
    const first = await store.getState().listHulyComments('CORE-1', undefined)
    expect(first).toEqual([comment])
    hulyListComments.mockClear()
    const second = await store.getState().listHulyComments('CORE-1', undefined)
    expect(second).toEqual([comment])
    expect(hulyListComments).not.toHaveBeenCalled()
  })

  it('listHulyComments returns an empty array on error', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hulyListComments.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    const result = await store.getState().listHulyComments('CORE-1', undefined)
    expect(result).toEqual([])
    errSpy.mockRestore()
  })

  it('listHulyTeams caches results and uses active connectionId', async () => {
    hulyListTeams.mockResolvedValueOnce([])
    const store = createTestStore()
    store.setState({ hulyStatus: connected })
    await store.getState().listHulyTeams(undefined, undefined)
    expect(hulyListTeams).toHaveBeenCalledWith(undefined, 'huly-1')
    await store.getState().listHulyTeams(undefined, undefined)
    expect(hulyListTeams).toHaveBeenCalledTimes(1)
  })

  it('listHulyTeams returns an empty array on error', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hulyListTeams.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    const result = await store.getState().listHulyTeams(undefined, undefined)
    expect(result).toEqual([])
    errSpy.mockRestore()
  })

  it('listHulyProjects caches results', async () => {
    const project: HulyProjectSummary = { id: 'p-1', name: 'Migration' }
    hulyListProjects.mockResolvedValueOnce([project])
    const store = createTestStore()
    store.setState({ hulyStatus: connected })
    const first = await store.getState().listHulyProjects(undefined, undefined, undefined)
    expect(first).toEqual([project])
    hulyListProjects.mockClear()
    const second = await store.getState().listHulyProjects(undefined, undefined, undefined)
    expect(second).toEqual([project])
    expect(hulyListProjects).not.toHaveBeenCalled()
  })

  it('listHulyProjects returns empty array on error', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hulyListProjects.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    const result = await store.getState().listHulyProjects(undefined, undefined, undefined)
    expect(result).toEqual([])
    errSpy.mockRestore()
  })

  it('fetchHulyProject returns null on error', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hulyGetProject.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    const result = await store.getState().fetchHulyProject('p-1', undefined)
    expect(result).toBeNull()
    errSpy.mockRestore()
  })

  it('createHulyProject strips null connectionId before forwarding', async () => {
    hulyCreateProject.mockResolvedValueOnce({
      ok: true,
      project: { id: 'p-2', name: 'New Project' }
    })
    const store = createTestStore()
    await store.getState().createHulyProject({ name: 'New Project', connectionId: null }, undefined)
    expect(hulyCreateProject).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ name: 'New Project', connectionId: undefined })
    )
  })

  it('createHulyProject returns ok:false when the runtime call throws', async () => {
    hulyCreateProject.mockRejectedValueOnce(new Error('boom'))
    const store = createTestStore()
    const result = await store.getState().createHulyProject({ name: 'X' }, undefined)
    expect(result.ok).toBe(false)
  })

  it('invalidateHulyIssueLists bumps the token version', () => {
    const store = createTestStore()
    const before = store.getState().hulyListInvalidationToken.version
    store.getState().invalidateHulyIssueLists()
    const after = store.getState().hulyListInvalidationToken.version
    expect(after).toBeGreaterThan(before)
  })

  it('invalidateHulyIssueLists prunes matching list cache entries', () => {
    const store = createTestStore()
    const sourceContext = {
      kind: 'task-source' as const,
      provider: 'huly' as const,
      projectId: 'p',
      hostId: LOCAL_EXECUTION_HOST_ID as ExecutionHostId,
      projectHostSetupId: null,
      repoId: null,
      providerIdentity: null
    }
    const matchingScope = hulyCacheScopeForTest(sourceContext)
    const otherScope = 'remote::huly-2'
    store.setState({
      hulyListCache: {
        [`${matchingScope}::huly-1::all::50`]: { data: [], fetchedAt: Date.now() },
        [`${otherScope}::huly-1::all::50`]: { data: [], fetchedAt: Date.now() }
      }
    })
    store.getState().invalidateHulyIssueLists({ sourceContext })
    expect(Object.keys(store.getState().hulyListCache)).toEqual([`${otherScope}::huly-1::all::50`])
  })

  it('resetHulyCaches clears every cache map', () => {
    const store = createTestStore()
    store.setState({
      hulyIssueCache: { 'local::huly-1::CORE-1': { data: {} as never, fetchedAt: 0 } },
      hulyListCache: { 'local::huly-1::all::50': { data: [], fetchedAt: 0 } }
    })
    store.getState().resetHulyCaches()
    expect(store.getState().hulyIssueCache).toEqual({})
    expect(store.getState().hulyListCache).toEqual({})
  })
})
