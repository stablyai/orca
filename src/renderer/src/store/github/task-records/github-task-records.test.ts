import { answered } from '../requests/answered-request.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from '../github-slice-test-harness'
import { getTaskPageRepoSourceContext } from '@/lib/work-items/task-repo-source-context'
import { resetTaskPageGitHubMutationRegistryForTests } from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('@/lib/work-items/github/github-work-item-source-lookup', () => ({
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
const row: GitHubWorkItem = {
  id: 'issue:42',
  repoId: 'repo',
  type: 'issue',
  number: 42,
  title: 'Original',
  state: 'open',
  labels: [],
  assignees: [],
  url: 'https://github.com/acme/widgets/issues/42',
  author: null,
  updatedAt: '2026-10-31T12:00:02Z'
}
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
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
function setup(repos = [repo]) {
  const store = createTestStore()
  store.setState({ repos })
  const cache = store.getState().githubTaskCache
  const binding = cache.capture(repos[0])!
  return { store, cache, binding }
}
const sources = {
  issues: { owner: 'acme', repo: 'widgets' },
  prs: null,
  originCandidate: null,
  upstreamCandidate: null
}
/** A Tasks row cached by the real fetch, plus a binding captured for its source. */
async function tasksRow(store: ReturnType<typeof createTestStore>, item: GitHubWorkItem = row) {
  mockApi.gh.listWorkItems.mockResolvedValue({ items: [item], sources })
  const sourceContext = getTaskPageRepoSourceContext(repo, 'github')
  await store.getState().fetchWorkItems(repo.id, repo.path, 20, '', { sourceContext })
  const copy = () => Object.values(store.getState().workItemsCache).flatMap((e) => e.data ?? [])[0]
  const capture = () => store.getState().githubTaskCache.capture(repo, sourceContext)!
  const search = async () =>
    answered(
      await store
        .getState()
        .fetchWorkItems(repo.id, repo.path, 20, '', { sourceContext, force: true })
    )[0]
  return { copy, capture, search }
}

/** An account switch and back: the old binding is disposed and a new incarnation replaces it. */
function rebind(store: ReturnType<typeof createTestStore>) {
  store.setState({ repos: [{ ...repo, ghAccount: { host: 'github.com', user: 'bob' } }] })
  store.setState({ repos: [repo] })
}

function taskFacts(item: GitHubWorkItem) {
  return { title: item.title, state: item.state, labels: item.labels }
}

describe('shared GitHub task records through production store actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    resetTaskPageGitHubMutationRegistryForTests()
    // This mock represents the already-shipped safe local item route.
    Object.assign(mockApi.gh, { workItemByOwnerRepo: vi.fn() })
    lookup.mockReset()
    lookup.mockResolvedValue(row)
  })

  it('rejects pre-edit canonical C and coalesces one replacement after B settles', async () => {
    const { cache, binding } = setup()
    const c = deferred<GitHubWorkItem>()
    const c2 = deferred<GitHubWorkItem>()
    lookup.mockReturnValue(c2.promise)
    const read = cache.readCanonical(row, binding, () => c.promise)
    const b = cache.operation(row, binding, { labels: { new: true } })
    b(true)
    expect(lookup).not.toHaveBeenCalled()
    c.resolve(row)
    expect(await read).toBe(false)

    c2.resolve({ ...row, labels: ['new'] })
    await flush()
    expect(cache.projectItem(row).labels).toEqual(['new'])
  })

  it('disposes an account incarnation and rejects its deferred result after A to B to A', async () => {
    const { store, cache, binding } = setup()
    const response = deferred<GitHubWorkItem>()
    const read = cache.readCanonical(row, binding, () => response.promise)
    const listener = vi.fn()
    cache.subscribe(listener)
    store.setState({ repos: [{ ...repo, ghAccount: { host: 'github.com', user: 'bob' } }] })
    store.setState({ repos: [repo] })
    response.resolve({ ...row, title: 'Old Alice' })
    expect(await read).toBe(false)
    expect(cache.current(binding)).toBe(false)
    expect(cache.projectItem(row).title).toBe('Original')
    expect(listener).toHaveBeenCalled()
    expect(cache.capture(repo)!.incarnation).not.toBe(binding.incarnation)
  })

  it('establishes from the read after the last of two overlapping edits', async () => {
    const { store, cache } = setup()
    const { capture } = await tasksRow(store)
    const r1 = deferred<GitHubWorkItem>(),
      r2 = deferred<GitHubWorkItem>()
    lookup.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise)
    cache.operation(row, capture(), { labels: { a: true } })(true)
    cache.operation(row, capture(), { labels: { b: true } })(true)

    r1.resolve({ ...row, labels: ['a'], updatedAt: '2026-10-31T12:00:03Z' })
    await flush()

    expect(cache.projectItem(row).labels).toEqual(['a', 'b'])
    const after = {
      ...row,
      title: 'After B',
      labels: ['a', 'b'],
      updatedAt: '2026-10-31T12:00:04Z'
    }
    r2.resolve(after)
    await flush()
    expect(taskFacts(cache.projectItem(row))).toEqual(taskFacts(after))
    cache.acceptSearch([after], capture())
    await flush()
  })

  it('leaves copies to a replacement incarnation and reconciles them with its own read', async () => {
    const { store, cache } = setup()
    const { copy, capture } = await tasksRow(store)
    await cache.readCanonical(row, capture(), async () => row)
    const old = cache.operation(row, capture(), { labels: { old: true } })
    expect(copy().labels).toEqual([])
    rebind(store)
    await tasksRow(store)
    const next = cache.operation(copy(), capture(), { labels: { new: true } })
    expect(cache.projectItem(copy()).labels).toEqual(['new'])
    expect(old(false).labels).toEqual([])
    lookup.mockResolvedValue({ ...row, title: 'Reconciled', updatedAt: '2026-10-31T12:00:03Z' })
    next(false)
    await flush()
    // The late old settlement owes the replacement its own read, even though its own edit failed.

    expect(copy()).toMatchObject({ title: 'Reconciled', labels: [] })
  })
  it('lets a Refresh queued behind a discarded one read once that owner retires', async () => {
    const { cache, binding } = setup()
    const first = deferred<GitHubWorkItem | null>()
    const r1 = cache.readCanonical(row, binding, () => first.promise)
    const second = vi.fn(async () => ({ ...row, title: 'Fresh' }))
    const r2 = cache.readCanonical(row, binding, second)
    first.resolve(null)
    expect([await r1, await r2]).toEqual([false, true])

    expect(cache.projectItem(row).title).toBe('Fresh')
  })
})
