import { setRuntimeEnvironmentConnectionGenerationForTests } from './runtime-status-connection-generation'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'
import { getTaskPageRepoSourceContext } from '@/lib/task-repo-source-context'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('@/lib/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemByOwnerRepoForSource: lookup
}))
const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1,
  ghAccount: { host: 'github.com', user: 'alice' }
}
const issue = (number: number): GitHubWorkItem => ({
  id: `issue:${number}`,
  repoId: 'repo',
  type: 'issue',
  number,
  title: 'Original',
  state: 'open',
  labels: [],
  assignees: [],
  url: `https://github.com/acme/widgets/issues/${number}`,
  author: null,
  updatedAt: '2026-10-31T12:00:02Z'
})
const row = issue(42)
const user = { login: 'alice', name: 'Alice', avatarUrl: 'alice.png' }
const sources = {
  issues: { owner: 'acme', repo: 'widgets' },
  prs: null,
  originCandidate: null,
  upstreamCandidate: null
}
const unsupported = () =>
  new RuntimeRpcCallError({
    id: 'old-server',
    ok: false,
    error: { code: 'method_not_found', message: 'unsupported' }
  })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((r, fail) => {
    resolve = r
    reject = fail
  })
  return { promise, resolve, reject }
}
async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
  }
}
/** A paired server on its own connection; `reconnect` advances it the way a dropped transport does. */
function remoteSetup(environmentId: string) {
  setRuntimeEnvironmentConnectionGenerationForTests(environmentId, 1)
  const remote: Repo = { ...repo, executionHostId: `runtime:${environmentId}` }
  const store = createTestStore()
  store.setState({ repos: [remote] })
  const cache = store.getState().githubTaskCache
  let generation = 1
  const reconnect = () => {
    setRuntimeEnvironmentConnectionGenerationForTests(environmentId, ++generation)
    store.setState({ runtimeStatusByEnvironmentId: new Map() })
  }
  return {
    cache,
    binding: cache.capture(remote)!,
    capture: () => cache.capture(remote)!,
    reconnect
  }
}

describe('task record reads across failures and reconnects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    lookup.mockReset()
  })

  it('parks unusable reads, retries one per delivery oldest first, then shows the outside reversal', async () => {
    const store = createTestStore()
    store.setState({ repos: [repo] })
    const items = [42, 43, 44].map(issue)
    const sourceContext = getTaskPageRepoSourceContext(repo, 'github')
    const deliver = async () => {
      await store
        .getState()
        .fetchWorkItems(repo.id, repo.path, 20, '', { sourceContext, force: true })
      await flush()
    }
    mockApi.gh.listWorkItems.mockResolvedValue({ items, sources })
    await deliver()
    const cache = store.getState().githubTaskCache
    const binding = cache.capture(repo, sourceContext)!
    const answers = new Map<number, Promise<GitHubWorkItem | null>>()
    lookup.mockImplementation(async ({ number }) => answers.get(number) ?? null)
    for (const item of items) {
      cache.operation(item, binding, { assignees: { alice: user } })(true)
      await flush()
    }
    // Each newly settled write gets its own first read; all three answer nothing usable.
    expect(lookup.mock.calls.map(([args]) => args.number)).toEqual([42, 43, 44])
    // A teammate unassigns alice on GitHub; the search index already shows it at a newer version.
    const reversed = (item: GitHubWorkItem) => ({ ...item, updatedAt: '2026-10-31T13:00:00Z' })
    mockApi.gh.listWorkItems.mockResolvedValue({ items: items.map(reversed), sources })
    const shown = () =>
      Object.values(store.getState().workItemsCache)
        .flatMap((entry) => entry.data ?? [])
        .map((item) => cache.projectItem(item).assignees?.map((value) => value.login))
    const turns = async () => {
      lookup.mockClear()
      await deliver()
      return lookup.mock.calls.map(([args]) => args.number)
    }
    // One retry per delivery for the binding, longest-waiting first; confirmed edits stay shown.
    expect([await turns(), await turns(), await turns()]).toEqual([[42], [43], [44]])
    expect(shown()).toEqual([['alice'], ['alice'], ['alice']])

    // 42's next turn is crossed by a new edit: its answer is refused and the settled edit reads again.
    const crossed = deferred<GitHubWorkItem | null>()
    answers.set(42, crossed.promise)
    expect(await turns()).toEqual([42])
    const settle = cache.operation(items[0], binding, { labels: { bug: true } })
    crossed.resolve(reversed(items[0]))
    await flush()
    expect(shown()[0]).toEqual(['alice'])
    answers.set(42, Promise.resolve({ ...reversed(items[0]), labels: ['bug'] }))
    lookup.mockClear()
    settle(true)
    await flush()
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(cache.projectItem(items[0])).toMatchObject({ assignees: [], labels: ['bug'] })
    const indexed = { ...reversed(items[0]), labels: ['bug'] }
    mockApi.gh.listWorkItems.mockResolvedValue({
      items: [indexed, ...items.slice(1).map(reversed)],
      sources
    })

    // The others recover on their next turns, and a cleared obligation is never read again.
    answers.set(43, Promise.resolve(reversed(items[1])))
    answers.set(44, Promise.resolve(reversed(items[2])))
    expect([await turns(), await turns(), await turns()]).toEqual([[43], [44], []])
    expect(shown()).toEqual([[], [], []])
  })

  it('parks only owed reads: a failed Refresh with nothing owed leaves a later obligation first in line', async () => {
    const store = createTestStore()
    store.setState({ repos: [repo] })
    const [parked, idle] = [41, 44].map(issue)
    const sourceContext = getTaskPageRepoSourceContext(repo, 'github')
    mockApi.gh.listWorkItems.mockResolvedValue({ items: [parked, idle], sources })
    const deliver = async () => {
      lookup.mockClear()
      await store
        .getState()
        .fetchWorkItems(repo.id, repo.path, 20, '', { sourceContext, force: true })
      await flush()
      return lookup.mock.calls.map(([args]) => args.number)
    }
    await deliver()
    const cache = store.getState().githubTaskCache
    const binding = cache.capture(repo, sourceContext)!
    expect(await cache.readCanonical(idle, binding, async () => idle)).toBe(true)
    lookup.mockResolvedValue(null)
    cache.operation(parked, binding, { assignees: { alice: user } })(true)
    await flush()
    // A user Refresh on the idle issue fails once; it owed nothing, so nothing parks.
    expect(await cache.readCanonical(idle, binding, async () => null)).toBe(false)
    // A same-second outside rename now owes a read, which runs on this delivery, not after parked ones.
    const renamed = { ...idle, title: 'Renamed' }
    lookup.mockImplementation(async ({ number }) => (number === 44 ? renamed : null))
    mockApi.gh.listWorkItems.mockResolvedValue({ items: [parked, renamed], sources })
    expect(await deliver()).toContain(44)
    expect(cache.projectItem(idle).title).toBe('Renamed')
  })

  it('keeps a record through a reconnect, refusing the old connection and reading on the new one', async () => {
    const { cache, binding, capture, reconnect } = remoteSetup('p34245-reconnect')
    // The dialog's assign was confirmed by a newer reading.
    lookup.mockResolvedValue({ ...row, assignees: [user], updatedAt: '2026-10-31T12:00:05Z' })
    cache.operation(row, binding, { assignees: { alice: user } })(true)
    await flush()
    const response = deferred<GitHubWorkItem>()
    const read = cache.readCanonical(row, binding, () => response.promise)
    reconnect()
    response.resolve({ ...row, title: 'Old connection', updatedAt: '2026-10-31T12:00:09Z' })
    expect(await read).toBe(false)
    expect(cache.current(binding)).toBe(false)
    // The search index still has the row from before the assign; the reconnect doesn't undo it.
    const fresh = capture()
    expect(fresh.incarnation).toBe(binding.incarnation)
    expect(cache.acceptSearch([row], fresh)[0].assignees).toEqual([user])
    const next = { ...row, title: 'New connection', updatedAt: '2026-10-31T12:00:09Z' }
    expect(await cache.readCanonical(row, fresh, async () => next)).toBe(true)
    expect(cache.projectItem(row)).toMatchObject({ title: 'New connection', assignees: [] })
  })

  it('marks only the connection that answered unsupported, so an upgraded server reads again', async () => {
    const { cache, binding, capture, reconnect } = remoteSetup('p34245-upgrade')
    const old = deferred<GitHubWorkItem>()
    lookup.mockReturnValueOnce(old.promise)
    cache.operation(row, binding, { labels: { bug: true } })(true)
    // The server is upgraded and reconnects before the old server's late refusal arrives.
    reconnect()
    old.reject(unsupported())
    await flush()
    const upgraded = capture()
    expect(cache.canTrack(upgraded)).toBe(true)
    expect(cache.readRevision(row, upgraded)).not.toBe(0)
    expect(cache.projectItem(row).labels).toEqual(['bug'])
    // A refusal from the current connection marks it; the next connection is asked again.
    await cache.readCanonical(row, upgraded, () => Promise.reject(unsupported()))
    expect(cache.canTrack(upgraded)).toBe(false)
    reconnect()
    const accepted = await cache.readCanonical(row, capture(), async () => ({
      ...row,
      labels: ['bug'],
      title: 'Refreshed'
    }))
    expect(accepted).toBe(true)
  })
})
