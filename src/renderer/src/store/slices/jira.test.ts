import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { JiraConnectionStatus, JiraIssue, JiraViewer } from '../../../../shared/types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { credentialDecryptionMessage } from '../../../../shared/integration-credential-errors'
import { createJiraSlice } from './jira'

const jiraStatus = vi.fn()
const jiraConnect = vi.fn()
const jiraDisconnect = vi.fn()
const jiraGetIssue = vi.fn()
const jiraListIssues = vi.fn()
const jiraSearchIssues = vi.fn()
const jiraSelectSite = vi.fn()
const jiraTestConnection = vi.fn()

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraAddIssueComment: vi.fn(),
  jiraConnect: (...args: unknown[]) => jiraConnect(...args),
  jiraCreateIssue: vi.fn(),
  jiraDisconnect: (...args: unknown[]) => jiraDisconnect(...args),
  jiraGetIssue: (...args: unknown[]) => jiraGetIssue(...args),
  jiraIssueComments: vi.fn(),
  jiraListCreateFields: vi.fn(),
  jiraListIssueTypes: vi.fn(),
  jiraListIssues: (...args: unknown[]) => jiraListIssues(...args),
  jiraListPriorities: vi.fn(),
  jiraListProjects: vi.fn(),
  jiraSearchIssues: (...args: unknown[]) => jiraSearchIssues(...args),
  jiraSelectSite: (...args: unknown[]) => jiraSelectSite(...args),
  jiraStatus: (...args: unknown[]) => jiraStatus(...args),
  jiraTestConnection: (...args: unknown[]) => jiraTestConnection(...args),
  jiraUpdateIssue: vi.fn()
}))

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        settings: null,
        ...createJiraSlice(...a)
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

function status(email: string): JiraConnectionStatus {
  return { connected: true, viewer: { email } as JiraViewer }
}

function issue(key: string): JiraIssue {
  return {
    id: key,
    key,
    title: key,
    url: `https://example.atlassian.net/browse/${key}`,
    siteId: 'site-1',
    siteName: 'Example Jira',
    project: { id: '10000', key: 'ALP', name: 'Alpha', siteId: 'site-1' },
    issueType: { id: '10001', name: 'Bug' },
    status: { id: '1', name: 'Todo', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function jiraSourceContext(environmentId: string, siteId = 'site-1'): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'jira',
    projectId: 'logical-project',
    hostId: `runtime:${environmentId}`,
    providerIdentity: {
      provider: 'jira',
      siteId
    }
  }
}

describe('createJiraSlice runtime context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ignores stale status responses after the active runtime changes', async () => {
    const store = createTestStore()
    const localStatus = deferred<JiraConnectionStatus>()
    const remoteStatus = deferred<JiraConnectionStatus>()
    jiraStatus.mockReturnValueOnce(localStatus.promise).mockReturnValueOnce(remoteStatus.promise)

    const localRequest = store.getState().checkJiraConnection()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })
    const remoteRequest = store.getState().checkJiraConnection()

    remoteStatus.resolve(status('remote@example.com'))
    await remoteRequest
    expect(store.getState().jiraStatus.viewer?.email).toBe('remote@example.com')
    expect(store.getState().jiraStatusContextKey).toBe('runtime:runtime-1#0')

    localStatus.resolve(status('local@example.com'))
    await localRequest
    expect(store.getState().jiraStatus.viewer?.email).toBe('remote@example.com')
    expect(store.getState().jiraStatusContextKey).toBe('runtime:runtime-1#0')
  })

  it('ignores stale issue cache writes after the active runtime changes', async () => {
    const store = createTestStore()
    const localIssue = deferred<JiraIssue | null>()
    const remoteIssue = deferred<JiraIssue | null>()
    jiraGetIssue.mockReturnValueOnce(localIssue.promise).mockReturnValueOnce(remoteIssue.promise)

    const localRequest = store.getState().fetchJiraIssue('ORC-1')
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })
    const remoteRequest = store.getState().fetchJiraIssue('ORC-1')

    remoteIssue.resolve({ ...issue('ORC-1'), title: 'Remote issue' })
    await remoteRequest
    expect(store.getState().jiraIssueCache['selected::ORC-1']?.data?.title).toBe('Remote issue')

    localIssue.resolve({ ...issue('ORC-1'), title: 'Local issue' })
    await localRequest
    expect(store.getState().jiraIssueCache['selected::ORC-1']?.data?.title).toBe('Remote issue')
  })

  it('routes explicit source reads through their source context when focused runtime changes', async () => {
    const store = createTestStore()
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    const sourceContext = jiraSourceContext('source-runtime')
    const sourceResult = deferred<JiraIssue[]>()
    jiraListIssues.mockReturnValueOnce(sourceResult.promise)

    const request = store.getState().listJiraIssues('assigned', 30, { sourceContext })
    store.setState({ settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as never })

    sourceResult.resolve([{ ...issue('ALP-1'), title: 'Source issue' }])
    await expect(request).resolves.toMatchObject([{ key: 'ALP-1', title: 'Source issue' }])
    expect(jiraListIssues).toHaveBeenCalledWith(sourceContext, 'assigned', 30, 'site-1')
    expect(Object.values(store.getState().jiraSearchCache)).toHaveLength(1)
    expect(store.getState().jiraSearchCache['site-1::list::assigned::30']).toBeUndefined()
  })

  it('scopes optimistic issue patches to the selected Jira source context', () => {
    const store = createTestStore()
    const localSource = jiraSourceContext('local-runtime')
    const remoteSource = jiraSourceContext('remote-runtime')
    const localScope = getTaskSourceCacheScope(localSource)
    const remoteScope = getTaskSourceCacheScope(remoteSource)

    store.setState({
      jiraIssueCache: {
        [`${localScope}::site-1::ALP-1`]: {
          data: { ...issue('ALP-1'), title: 'Local title' },
          fetchedAt: Date.now()
        },
        [`${remoteScope}::site-1::ALP-1`]: {
          data: { ...issue('ALP-1'), title: 'Remote title' },
          fetchedAt: Date.now()
        }
      },
      jiraSearchCache: {
        [`${localScope}::site-1::list::assigned::30`]: {
          data: [{ ...issue('ALP-1'), title: 'Local title' }],
          fetchedAt: Date.now()
        },
        [`${remoteScope}::site-1::list::assigned::30`]: {
          data: [{ ...issue('ALP-1'), title: 'Remote title' }],
          fetchedAt: Date.now()
        }
      }
    })

    store.getState().patchJiraIssue(
      'ALP-1',
      { title: 'Patched local title' },
      {
        sourceContext: localSource
      }
    )

    expect(store.getState().jiraIssueCache[`${localScope}::site-1::ALP-1`]?.data?.title).toBe(
      'Patched local title'
    )
    expect(store.getState().jiraIssueCache[`${remoteScope}::site-1::ALP-1`]?.data?.title).toBe(
      'Remote title'
    )
    expect(
      store.getState().jiraSearchCache[`${localScope}::site-1::list::assigned::30`]?.data?.[0]
        ?.title
    ).toBe('Patched local title')
    expect(
      store.getState().jiraSearchCache[`${remoteScope}::site-1::list::assigned::30`]?.data?.[0]
        ?.title
    ).toBe('Remote title')
  })

  it('returns a failed Jira connect result when the active runtime changes before completion', async () => {
    const store = createTestStore()
    const connectResult = deferred<{ ok: true; viewer: JiraViewer }>()
    jiraConnect.mockReturnValueOnce(connectResult.promise)

    const request = store.getState().connectJira({
      siteUrl: 'https://example.atlassian.net',
      email: 'local@example.com',
      apiToken: 'token'
    })
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })

    connectResult.resolve({ ok: true, viewer: { email: 'local@example.com' } as JiraViewer })
    await expect(request).resolves.toEqual({
      ok: false,
      error: 'Jira connection was superseded by a newer request.'
    })
    expect(store.getState().jiraStatus.connected).toBe(false)
    expect(store.getState().jiraStatusContextKey).toBeNull()
  })

  it('does not run a stale test follow-up status check after the active runtime changes', async () => {
    const store = createTestStore()
    const testResult = deferred<{ ok: true; viewer: JiraViewer }>()
    jiraTestConnection.mockReturnValueOnce(testResult.promise)

    const request = store.getState().testJiraConnection()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })

    testResult.resolve({ ok: true, viewer: { email: 'local@example.com' } as JiraViewer })
    await request
    expect(jiraStatus).not.toHaveBeenCalled()
  })

  it('does not clear or refresh stale disconnect results after the active runtime changes', async () => {
    const store = createTestStore()
    const disconnectResult = deferred<void>()
    jiraDisconnect.mockReturnValueOnce(disconnectResult.promise)

    const request = store.getState().disconnectJira()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })

    disconnectResult.resolve()
    await request
    expect(jiraStatus).not.toHaveBeenCalled()
  })
})

describe('createJiraSlice credential errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('serves fresh Jira cache without reading credentials', async () => {
    const store = createTestStore()
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' },
      jiraSearchCache: {
        'site-1::list::assigned::30': { data: [issue('ALP-1')], fetchedAt: Date.now() }
      }
    })

    await expect(store.getState().listJiraIssues('assigned', 30)).resolves.toMatchObject([
      { key: 'ALP-1' }
    ])

    expect(jiraListIssues).not.toHaveBeenCalled()
  })

  it('returns an empty list and surfaces the credential error in status on Jira decrypt errors', async () => {
    const store = createTestStore()
    const error = new Error(credentialDecryptionMessage('Jira'))
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    jiraStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      selectedSiteId: 'site-1',
      credentialError: error.message
    })
    jiraSearchIssues.mockRejectedValueOnce(error)

    await expect(store.getState().searchJiraIssues('project = ALP', 30)).resolves.toEqual([])
    await vi.waitFor(() => {
      expect(store.getState().jiraStatus.credentialError).toBe(error.message)
    })
  })

  it('returns null and refreshes status on Jira decrypt errors during detail refresh', async () => {
    const store = createTestStore()
    const error = new Error(credentialDecryptionMessage('Jira'))
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' },
      jiraIssueCache: {
        'site-1::ALP-1': { data: issue('ALP-1'), fetchedAt: 1 }
      }
    })
    jiraStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      selectedSiteId: 'site-1',
      credentialError: error.message
    })
    jiraGetIssue.mockRejectedValueOnce(error)

    await expect(store.getState().fetchJiraIssue('ALP-1', 'site-1')).resolves.toBeNull()
    expect(jiraStatus).toHaveBeenCalled()
  })

  it('refreshes status after all-site Jira list reads partially succeed', async () => {
    const store = createTestStore()
    const error = new Error(credentialDecryptionMessage('Jira'))
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'all' }
    })
    jiraListIssues.mockResolvedValueOnce([issue('ALP-1')])
    jiraStatus.mockResolvedValueOnce({
      connected: true,
      viewer: null,
      selectedSiteId: 'all',
      credentialError: error.message
    })

    await expect(store.getState().listJiraIssues('assigned', 30)).resolves.toMatchObject([
      { key: 'ALP-1' }
    ])
    await vi.waitFor(() => {
      expect(store.getState().jiraStatus.credentialError).toBe(error.message)
    })
  })

  it('clears stale Jira credential errors after successful site list reads', async () => {
    const store = createTestStore()
    const staleError = credentialDecryptionMessage('Jira')
    store.setState({
      jiraStatus: {
        connected: true,
        viewer: null,
        selectedSiteId: 'site-1',
        credentialError: staleError
      }
    })
    jiraListIssues.mockResolvedValueOnce([issue('ALP-1')])
    jiraStatus.mockResolvedValueOnce({
      connected: true,
      viewer: null,
      selectedSiteId: 'site-1'
    })

    await expect(store.getState().listJiraIssues('assigned', 30)).resolves.toMatchObject([
      { key: 'ALP-1' }
    ])
    await vi.waitFor(() => {
      expect(store.getState().jiraStatus.credentialError).toBeUndefined()
    })
  })

  it('clears stale Jira credential errors after successful issue detail reads', async () => {
    const store = createTestStore()
    const staleError = credentialDecryptionMessage('Jira')
    store.setState({
      jiraStatus: {
        connected: true,
        viewer: null,
        selectedSiteId: 'site-1',
        credentialError: staleError
      }
    })
    jiraGetIssue.mockResolvedValueOnce(issue('ALP-1'))
    jiraStatus.mockResolvedValueOnce({
      connected: true,
      viewer: null,
      selectedSiteId: 'site-1'
    })

    await expect(store.getState().fetchJiraIssue('ALP-1', 'site-1')).resolves.toMatchObject({
      key: 'ALP-1'
    })
    await vi.waitFor(() => {
      expect(store.getState().jiraStatus.credentialError).toBeUndefined()
    })
  })

  it('keeps Jira connected when an issue read hits endpoint-level forbidden access', async () => {
    const store = createTestStore()
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    jiraListIssues.mockRejectedValueOnce(new Error('Forbidden'))

    await expect(store.getState().listJiraIssues('assigned', 30)).resolves.toEqual([])

    expect(store.getState().jiraStatus.connected).toBe(true)
  })
})
