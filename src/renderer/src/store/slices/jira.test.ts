import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { JiraConnectionStatus, JiraIssue, JiraViewer } from '../../../../shared/jira-types'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { credentialDecryptionMessage } from '../../../../shared/integration-credential-errors'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { createJiraSlice } from './jira'

const jiraStatus = vi.fn()
const jiraConnect = vi.fn()
const jiraDisconnect = vi.fn()
const jiraGetIssue = vi.fn()
const jiraLookupIssueSummary = vi.fn()
const jiraListIssues = vi.fn()
const jiraReadStatus = vi.fn()
const jiraSearchIssues = vi.fn()
const jiraSelectSite = vi.fn()
const jiraTestConnection = vi.fn()

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraAddIssueComment: vi.fn(),
  jiraConnect: (...args: unknown[]) => jiraConnect(...args),
  jiraCreateIssue: vi.fn(),
  jiraDisconnect: (...args: unknown[]) => jiraDisconnect(...args),
  jiraGetIssue: (...args: unknown[]) => jiraGetIssue(...args),
  jiraLookupIssueSummary: (...args: unknown[]) => jiraLookupIssueSummary(...args),
  jiraIssueComments: vi.fn(),
  jiraListCreateFields: vi.fn(),
  jiraListIssueTypes: vi.fn(),
  jiraListIssues: (...args: unknown[]) => jiraListIssues(...args),
  jiraReadStatus: (...args: unknown[]) => jiraReadStatus(...args),
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

  it('does not repopulate an old-site cache after selecting a new site', async () => {
    const store = createTestStore()
    const oldSiteIssues = deferred<JiraIssue[]>()
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    jiraSearchIssues.mockReturnValueOnce(oldSiteIssues.promise)
    jiraSelectSite.mockResolvedValueOnce({
      connected: true,
      viewer: null,
      selectedSiteId: 'site-2'
    })

    const oldSiteRequest = store.getState().searchJiraIssues('project = ALP', 30)
    await store.getState().selectJiraSite('site-2')
    oldSiteIssues.resolve([issue('ALP-1')])

    await expect(oldSiteRequest).resolves.toMatchObject([{ key: 'ALP-1' }])
    expect(store.getState().jiraStatus.selectedSiteId).toBe('site-2')
    expect(store.getState().jiraSearchCache).toEqual({})
  })

  it('isolates out-of-order issue reads from different source hosts', async () => {
    const store = createTestStore()
    const sourceA = jiraSourceContext('runtime-a')
    const sourceB = jiraSourceContext('runtime-b')
    const runtimeAIssue = deferred<JiraIssue | null>()
    const runtimeBIssue = deferred<JiraIssue | null>()
    jiraGetIssue
      .mockReturnValueOnce(runtimeAIssue.promise)
      .mockReturnValueOnce(runtimeBIssue.promise)

    const requestA = store.getState().fetchJiraIssue('ALP-1', 'site-1', {
      sourceContext: sourceA
    })
    const requestB = store.getState().fetchJiraIssue('ALP-1', 'site-1', {
      sourceContext: sourceB
    })
    runtimeBIssue.resolve({ ...issue('ALP-1'), title: 'Runtime B' })
    await requestB
    runtimeAIssue.resolve({ ...issue('ALP-1'), title: 'Runtime A' })
    await requestA

    expect(
      store.getState().jiraIssueCache[`${getTaskSourceCacheScope(sourceA)}::site-1::ALP-1`]?.data
        ?.title
    ).toBe('Runtime A')
    expect(
      store.getState().jiraIssueCache[`${getTaskSourceCacheScope(sourceB)}::site-1::ALP-1`]?.data
        ?.title
    ).toBe('Runtime B')
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

  it('keeps isolated status failures from mutating the focused Jira Settings state', async () => {
    const store = createTestStore()
    const focusedStatus = {
      connected: true,
      viewer: { email: 'focused@example.com' } as JiraViewer,
      selectedSiteId: 'site-1'
    }
    store.setState({
      jiraStatus: focusedStatus,
      jiraStatusChecked: true,
      jiraStatusContextKey: 'local#0'
    })
    jiraReadStatus.mockRejectedValueOnce(new Error('Source runtime credentials unavailable'))

    await expect(
      store.getState().readJiraStatus(jiraSourceContext('source-runtime'))
    ).rejects.toThrow('Source runtime credentials unavailable')

    expect(store.getState().jiraStatus).toEqual(focusedStatus)
    expect(store.getState().jiraStatusContextKey).toBe('local#0')
    expect(jiraStatus).not.toHaveBeenCalled()
  })

  it('isolates summary cache entries by source runtime and Jira site without bare-key fallback', async () => {
    const store = createTestStore()
    const sourceA = jiraSourceContext('runtime-a', 'site-1')
    const sourceB = jiraSourceContext('runtime-b', 'site-1')
    const sourceC = jiraSourceContext('runtime-a', 'site-2')
    store.setState({
      jiraIssueSummaryCache: {
        'site-1::ALP-1': {
          data: { ...issue('ALP-1'), title: 'Legacy bare summary' },
          fetchedAt: Date.now()
        }
      }
    })
    jiraLookupIssueSummary
      .mockResolvedValueOnce({ ...issue('ALP-1'), title: 'Runtime A' })
      .mockResolvedValueOnce({ ...issue('ALP-1'), title: 'Runtime B' })
      .mockResolvedValueOnce({
        ...issue('ALP-1'),
        siteId: 'site-2',
        title: 'Site 2'
      })

    await expect(
      store.getState().lookupJiraIssueSummary(sourceA, 'alp-1', 'site-1')
    ).resolves.toMatchObject({ title: 'Runtime A' })
    await expect(
      store.getState().lookupJiraIssueSummary(sourceB, 'ALP-1', 'site-1')
    ).resolves.toMatchObject({ title: 'Runtime B' })
    await expect(
      store.getState().lookupJiraIssueSummary(sourceC, 'ALP-1', 'site-2')
    ).resolves.toMatchObject({ title: 'Site 2' })
    await store.getState().lookupJiraIssueSummary(sourceA, 'ALP-1', 'site-1')

    expect(jiraLookupIssueSummary).toHaveBeenCalledTimes(3)
    expect(jiraLookupIssueSummary).toHaveBeenNthCalledWith(
      1,
      sourceA,
      'alp-1',
      'site-1',
      expect.any(AbortSignal)
    )
    expect(
      store.getState().jiraIssueSummaryCache[`${getTaskSourceCacheScope(sourceA)}::site-1::ALP-1`]
        ?.data?.title
    ).toBe('Runtime A')
    expect(
      store.getState().jiraIssueSummaryCache[`${getTaskSourceCacheScope(sourceB)}::site-1::ALP-1`]
        ?.data?.title
    ).toBe('Runtime B')
    expect(
      store.getState().jiraIssueSummaryCache[`${getTaskSourceCacheScope(sourceC)}::site-2::ALP-1`]
        ?.data?.title
    ).toBe('Site 2')
  })

  it('forces a fresh summary lookup and does not cache invalid fulfilled results', async () => {
    const store = createTestStore()
    const source = jiraSourceContext('runtime-a', 'site-1')
    const cacheKey = `${getTaskSourceCacheScope(source)}::site-1::ALP-1`
    store.setState({
      jiraIssueSummaryCache: {
        [cacheKey]: { data: null, fetchedAt: Date.now() }
      }
    })
    jiraLookupIssueSummary.mockResolvedValueOnce(issue('ALP-1'))

    await expect(
      store.getState().lookupJiraIssueSummary(source, 'ALP-1', 'site-1', { force: true })
    ).resolves.toMatchObject({ key: 'ALP-1' })

    expect(jiraLookupIssueSummary).toHaveBeenCalledWith(
      source,
      'ALP-1',
      'site-1',
      expect.any(AbortSignal)
    )
    expect(store.getState().jiraIssueSummaryCache[cacheKey]?.data?.key).toBe('ALP-1')

    jiraLookupIssueSummary.mockResolvedValueOnce(null)
    await store.getState().lookupJiraIssueSummary(source, 'ALP-2', 'site-1', { force: true })
    expect(
      store.getState().jiraIssueSummaryCache[`${getTaskSourceCacheScope(source)}::site-1::ALP-2`]
    ).toBeUndefined()
  })

  it('shares one summary read across abortable callers and cancels only when all abandon it', async () => {
    const store = createTestStore()
    const source = jiraSourceContext('runtime-a')
    const pending = deferred<JiraIssue>()
    let readSignal: AbortSignal | undefined
    jiraLookupIssueSummary.mockImplementation(
      (_settings: unknown, _key: string, _siteId: string, signal: AbortSignal) => {
        readSignal = signal
        return pending.promise
      }
    )
    const first = new AbortController()
    const second = new AbortController()

    const firstRead = store
      .getState()
      .lookupJiraIssueSummary(source, 'ALP-1', 'site-1', { signal: first.signal })
    const secondRead = store
      .getState()
      .lookupJiraIssueSummary(source, 'ALP-1', 'site-1', { signal: second.signal })
    expect(jiraLookupIssueSummary).toHaveBeenCalledTimes(1)

    first.abort()
    await expect(firstRead).rejects.toMatchObject({ name: 'AbortError' })
    expect(readSignal?.aborted).toBe(false)

    pending.resolve(issue('ALP-1'))
    await expect(secondRead).resolves.toMatchObject({ key: 'ALP-1' })
  })

  it('cancels a shared summary read once its last caller abandons it', async () => {
    const store = createTestStore()
    const source = jiraSourceContext('runtime-a')
    let readSignal: AbortSignal | undefined
    jiraLookupIssueSummary.mockImplementation(
      (_settings: unknown, _key: string, _siteId: string, signal: AbortSignal) => {
        readSignal = signal
        return new Promise<JiraIssue>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
    )
    const controller = new AbortController()

    const read = store
      .getState()
      .lookupJiraIssueSummary(source, 'ALP-1', 'site-1', { signal: controller.signal })
    controller.abort()

    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    expect(readSignal?.aborted).toBe(true)
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

  it('publishes a connection revision after disconnecting the active Jira source', async () => {
    const store = createTestStore()
    jiraDisconnect.mockResolvedValueOnce(undefined)
    jiraStatus.mockResolvedValueOnce({ connected: false, viewer: null })

    await store.getState().disconnectJira()

    expect(store.getState().jiraConnectionRevisions['local#0']).toBe(1)
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

  it('uses the selected site from an explicit workspace source context', async () => {
    const store = createTestStore()
    const source = jiraSourceContext('remote-runtime')
    jiraSearchIssues.mockResolvedValueOnce([issue('ALP-1')])

    await expect(
      store
        .getState()
        .searchJiraIssues('text ~ "search*"', 12, { sourceContext: source, siteId: 'site-2' })
    ).resolves.toMatchObject([{ key: 'ALP-1' }])

    expect(jiraSearchIssues).toHaveBeenCalledWith(
      source,
      'text ~ "search*"',
      12,
      'site-2',
      undefined
    )
  })

  it('publishes source-scoped auth changes without clearing focused Settings status', async () => {
    const store = createTestStore()
    const source = jiraSourceContext('remote-runtime')
    const focusedStatus = status('focused@example.com')
    store.setState({ jiraStatus: focusedStatus })
    jiraSearchIssues.mockRejectedValueOnce(new Error('Error 401: Unauthorized'))

    await expect(
      store
        .getState()
        .searchJiraIssues('text ~ "search*"', 12, { sourceContext: source, siteId: 'site-1' })
    ).resolves.toEqual([])

    const revisionKey = getProviderRuntimeContextKey(getTaskSourceRuntimeSettings(source))
    expect(store.getState().jiraConnectionRevisions[revisionKey]).toBe(1)
    expect(store.getState().jiraStatus).toEqual(focusedStatus)
  })

  it('does not borrow the global site when a workspace source has no selected site', async () => {
    const store = createTestStore()
    const source = jiraSourceContext('remote-runtime')
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'global-site' }
    })
    jiraSearchIssues.mockResolvedValueOnce([])

    await store
      .getState()
      .searchJiraIssues('text ~ "search*"', 12, { sourceContext: source, siteId: null })

    expect(jiraSearchIssues).toHaveBeenCalledWith(source, 'text ~ "search*"', 12, null, undefined)
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

  it('surfaces endpoint-level forbidden errors without disconnecting Jira', async () => {
    const store = createTestStore()
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    jiraListIssues.mockRejectedValueOnce(new Error('Forbidden'))

    // A non-auth failure must reject so the Tasks panel can show a real error
    // instead of a misleading empty list, while keeping the session connected.
    await expect(store.getState().listJiraIssues('assigned', 30)).rejects.toThrow('Forbidden')

    expect(store.getState().jiraStatus.connected).toBe(true)
  })

  it('surfaces endpoint-level search errors without disconnecting Jira', async () => {
    const store = createTestStore()
    store.setState({
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' }
    })
    jiraSearchIssues.mockRejectedValueOnce(new Error('Malformed JQL'))

    await expect(store.getState().searchJiraIssues('project =', 30)).rejects.toThrow(
      'Malformed JQL'
    )

    expect(store.getState().jiraStatus.connected).toBe(true)
  })
})
