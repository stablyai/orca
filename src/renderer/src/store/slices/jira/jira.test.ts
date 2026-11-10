import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { JiraIssue, JiraViewer } from '../../../../../shared/jira/jira-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/work-items/task-source-context'
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

vi.mock('@/runtime/jira/runtime-jira-client', () => ({
  jiraAddIssueComment: vi.fn(),
  jiraConnect: (...args: unknown[]) => jiraConnect(...args),
  jiraDisconnect: (...args: unknown[]) => jiraDisconnect(...args),
  jiraGetIssue: (...args: unknown[]) => jiraGetIssue(...args),
  jiraIssueComments: vi.fn(),
  jiraListCreateFields: vi.fn(),
  jiraListIssueTypes: vi.fn(),
  jiraListIssues: (...args: unknown[]) => jiraListIssues(...args),
  jiraListIssuesForTarget: (...args: unknown[]) => jiraListIssues(...args),
  jiraListPriorities: vi.fn(),
  jiraListProjects: vi.fn(),
  jiraSearchIssues: (...args: unknown[]) => jiraSearchIssues(...args),
  jiraSelectSite: (...args: unknown[]) => jiraSelectSite(...args),
  jiraStatus: (...args: unknown[]) => jiraStatus(...args),
  jiraTestConnection: (...args: unknown[]) => jiraTestConnection(...args),
  jiraUpdateIssue: vi.fn()
}))
vi.mock('@/runtime/jira/runtime-jira-user-fields-client', () => ({ jiraCreateIssue: vi.fn() }))
vi.mock('@/runtime/jira/runtime-jira-summary-client', () => ({
  jiraLookupIssueSummary: (...args: unknown[]) => jiraLookupIssueSummary(...args),
  jiraReadStatus: (...args: unknown[]) => jiraReadStatus(...args)
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

  it('reuses ordinary in-flight reads but force starts a fresh list and search request', async () => {
    const store = createTestStore()
    store.setState({ jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' } })
    const listOld = deferred<JiraIssue[]>()
    const listFresh = deferred<JiraIssue[]>()
    const searchOld = deferred<JiraIssue[]>()
    const searchFresh = deferred<JiraIssue[]>()
    jiraListIssues.mockReturnValueOnce(listOld.promise).mockReturnValueOnce(listFresh.promise)
    jiraSearchIssues.mockReturnValueOnce(searchOld.promise).mockReturnValueOnce(searchFresh.promise)

    const listRequest = store.getState().listJiraIssues('assigned', 30)
    const listReuse = store.getState().listJiraIssues('assigned', 30)
    const searchRequest = store.getState().searchJiraIssues('project = ALP', 30)
    const searchReuse = store.getState().searchJiraIssues('project = ALP', 30)
    await Promise.resolve()

    const listRefresh = store.getState().listJiraIssues('assigned', 30, { force: true })
    const searchRefresh = store.getState().searchJiraIssues('project = ALP', 30, { force: true })
    await Promise.resolve()

    listFresh.resolve([issue('ALP-LIST-FRESH')])
    searchFresh.resolve([issue('ALP-SEARCH-FRESH')])
    await expect(listRefresh).resolves.toMatchObject([{ key: 'ALP-LIST-FRESH' }])
    await expect(searchRefresh).resolves.toMatchObject([{ key: 'ALP-SEARCH-FRESH' }])
    listOld.resolve([issue('ALP-LIST-LATE')])
    searchOld.resolve([issue('ALP-SEARCH-LATE')])
    await expect(listRequest).resolves.toMatchObject([{ key: 'ALP-LIST-LATE' }])
    await expect(listReuse).resolves.toMatchObject([{ key: 'ALP-LIST-LATE' }])
    await expect(searchRequest).resolves.toMatchObject([{ key: 'ALP-SEARCH-LATE' }])
    await expect(searchReuse).resolves.toMatchObject([{ key: 'ALP-SEARCH-LATE' }])

    expect(store.getState().jiraSearchCache['site-1::list::assigned::30']?.data).toMatchObject([
      { key: 'ALP-LIST-FRESH' }
    ])
    expect(store.getState().jiraSearchCache['site-1::project = ALP::30']?.data).toMatchObject([
      { key: 'ALP-SEARCH-FRESH' }
    ])
  })

  it('does not cache a late abortable search response', async () => {
    const store = createTestStore()
    store.setState({ jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' } })
    const pending = deferred<JiraIssue[]>()
    let signal: AbortSignal | undefined
    jiraSearchIssues.mockImplementationOnce(
      (_settings: unknown, _jql: string, _limit: number, _site: string, provided: AbortSignal) => {
        signal = provided
        return pending.promise
      }
    )
    const controller = new AbortController()
    const request = store
      .getState()
      .searchJiraIssues('project = ALP', 30, { signal: controller.signal })
    await Promise.resolve()
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    pending.resolve([issue('ALP-LATE')])
    await rejection
    expect(signal?.aborted).toBe(true)
    expect(store.getState().jiraSearchCache['site-1::project = ALP::30']).toBeUndefined()
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
        },
        [`${localScope}::site-2::ALP-1`]: {
          data: { ...issue('ALP-1'), siteId: 'site-2', title: 'Other site title' },
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
        },
        [`${localScope}::all::list::assigned::30`]: {
          data: [
            { ...issue('ALP-1'), siteId: 'site-2', title: 'Other site title' },
            { ...issue('ALP-1'), title: 'Local title' }
          ],
          fetchedAt: Date.now()
        }
      }
    })

    store.getState().patchJiraIssue(
      'ALP-1',
      { title: 'Patched local title' },
      {
        sourceContext: localSource,
        siteId: 'site-1'
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
    expect(store.getState().jiraIssueCache[`${localScope}::site-2::ALP-1`]?.data?.title).toBe(
      'Other site title'
    )
    expect(
      store
        .getState()
        .jiraSearchCache[`${localScope}::all::list::assigned::30`]?.data?.map((item) => item.title)
    ).toEqual(['Other site title', 'Patched local title'])
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
    await expect(request).resolves.toMatchObject({ ok: false })
    expect(store.getState().jiraStatus.connected).toBe(false)
    expect(store.getState().jiraStatusContextKey).toBeNull()
  })
})
