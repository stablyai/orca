import { answered } from '../requests/answered-request.test-fixture'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubProjectTable } from '../../../../../shared/github/project-types'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from '../github-slice-test-harness'
import { getTaskPageRepoSourceContext } from '@/lib/work-items/task-repo-source-context'
import { projectViewCacheKey } from '../cache/cache-identity'
import { getRegistryMergedTaskPageGitHubWorkItem } from '@/components/task-page/github/task-page-github-work-item-mutation-composition'
import {
  setConfirmedListSnapshot,
  setLastConfirmedClientValue,
  resetTaskPageGitHubMutationRegistryForTests
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

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
const user = { login: 'alice', name: 'Alice', avatarUrl: 'alice.png' }
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
const unsupported = () =>
  new RuntimeRpcCallError({
    id: 'old-server',
    ok: false,
    error: { code: 'method_not_found', message: 'unsupported' }
  })

/** An account switch and back: the old binding is disposed and a new incarnation replaces it. */
function rebind(store: ReturnType<typeof createTestStore>) {
  store.setState({ repos: [{ ...repo, ghAccount: { host: 'github.com', user: 'bob' } }] })
  store.setState({ repos: [repo] })
}
function board(rows: GitHubProjectTable['rows'] = []): GitHubProjectTable {
  return {
    project: {
      id: 'p',
      owner: 'acme',
      ownerType: 'organization',
      number: 1,
      title: 'Board',
      url: 'https://github.com/orgs/acme/projects/1'
    },
    selectedView: {
      id: 'v',
      number: 1,
      name: 'Table',
      layout: 'TABLE_LAYOUT',
      filter: '',
      fields: [],
      groupByFields: [],
      sortByFields: []
    },
    rows,
    totalCount: rows.length,
    parentFieldDropped: false
  }
}
function projectRow(id = 'r'): GitHubProjectTable['rows'][number] {
  return {
    id,
    position: 0,
    itemType: 'ISSUE',
    updatedAt: '2099-01-01T00:00:00Z',
    fieldValuesByFieldId: {},
    content: {
      title: 'Indexed',
      body: 'Board body',
      url: row.url,
      repository: 'Acme/Widgets',
      number: 42,
      state: 'OPEN',
      stateReason: null,
      isDraft: null,
      parentIssue: null,
      issueType: null,
      labels: [{ name: 'original', color: '123456' }],
      assignees: [{ login: 'alice', name: 'Board profile', avatarUrl: 'board.png' }]
    }
  }
}

/** F1 input: the board was fetched after the cached Tasks row and is fresher. */

function taskFacts(item: GitHubWorkItem) {
  return { title: item.title, state: item.state, labels: item.labels }
}
/** A board in the Project view cache, read back the way the board renders it. */

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

  it('serializes full and light reads and allows a same-second external reversal', async () => {
    const { cache, binding } = setup()
    const first = deferred<GitHubWorkItem>()
    lookup.mockReturnValue(first.promise)
    const edit = cache.operation(row, binding, { assignees: { alice: user } })
    edit(true)
    const full = vi.fn(async () => row)
    const refresh = cache.readCanonical(row, binding, full)
    expect(full).not.toHaveBeenCalled()
    first.resolve({ ...row, assignees: [user] })
    expect(await refresh).toBe(true)

    expect(cache.projectItem(row).assignees).toEqual([])
  })

  it('does not regress a newer provider version or erase unknown assignees', async () => {
    const { cache, binding } = setup()
    await cache.readCanonical(row, binding, async () => ({ ...row, assignees: [user] }))
    const unknown = {
      ...row,
      title: 'Newer',
      assignees: undefined,
      updatedAt: '2026-10-31T12:00:04Z'
    }
    expect(cache.acceptSearch([unknown], binding)[0].assignees).toEqual([user])
    expect(await cache.readCanonical(row, binding, async () => row)).toBe(false)
    expect(cache.projectItem(row).title).toBe('Newer')
  })

  it('retires relevant confirmed masks while preserving unrelated PR controls', async () => {
    const { cache, binding } = setup()
    setConfirmedListSnapshot(null, row.repoId, row.id, 'assignees', [user])
    setLastConfirmedClientValue(null, row.repoId, row.id, 'state', 'closed')
    setLastConfirmedClientValue(null, row.repoId, row.id, 'autoMerge', true)
    await cache.readCanonical(row, binding, async () => row)
    const merged = getRegistryMergedTaskPageGitHubWorkItem(cache.projectItem(row), null)
    expect(merged.assignees).toEqual([])
    expect(merged.state).toBe('open')
    expect(merged.autoMergeEnabled).toBe(true)
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

  it('projects only issue facts into another account board, preserving board data and ambiguity', async () => {
    const bobRepo = { ...repo, id: 'bob-repo', ghAccount: { host: 'github.com', user: 'bob' } }
    const { cache, binding } = setup([repo, bobRepo])
    const source = projectRow()
    const table = board([source])
    await cache.readCanonical(row, binding, async () => ({
      ...row,
      title: 'Confirmed',
      state: 'closed',
      labels: ['original', 'new'],
      assignees: [user]
    }))
    const bob = cache.capture(bobRepo)!
    await cache.readCanonical({ ...row, repoId: bobRepo.id }, bob, async () => ({
      ...row,
      repoId: bobRepo.id,
      title: 'Confirmed',
      state: 'closed',
      labels: ['original', 'new'],
      assignees: [user]
    }))
    const projected = cache.projectTable(table, 'local').rows[0]
    expect(projected.content.title).toBe('Confirmed')
    expect(projected.content.state).toBe('CLOSED')
    expect(projected.content.assignees).toEqual(source.content.assignees)
    expect(projected.content.labels[0]).toEqual(source.content.labels[0])
    expect(projected.content.body).toBe('Board body')
    expect(projected.updatedAt).toBe(source.updatedAt)
    expect(projected.fieldValuesByFieldId).toBe(source.fieldValuesByFieldId)
  })
  it('returns accepted rows on page N and never invents query membership', async () => {
    const { store, cache, binding } = setup()
    await cache.readCanonical(row, binding, async () => ({ ...row, labels: ['current'] }))
    mockApi.gh.listWorkItems.mockResolvedValue({
      items: [row],
      sources: {
        issues: { owner: 'acme', repo: 'widgets' },
        prs: null,
        originCandidate: null,
        upstreamCandidate: null
      }
    })
    lookup.mockResolvedValue({ ...row, labels: ['current'] })
    const result = answered(
      await store
        .getState()
        .fetchWorkItemsNextPage([{ repoId: repo.id, path: repo.path }], 20, 20, '', 2)
    )
    expect(result.items[0].labels).toEqual(['current'])
    mockApi.gh.listWorkItems.mockResolvedValue({
      items: [],
      sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    })
    expect(
      answered(
        await store
          .getState()
          .fetchWorkItemsNextPage([{ repoId: repo.id, path: repo.path }], 20, 20, '', 3)
      ).items
    ).toEqual([])
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
  it('keeps an unsupported record for its pending edits, joins new ones and owes no read', async () => {
    const { store, cache } = setup()
    const { copy, capture } = await tasksRow(store)
    const read = deferred<GitHubWorkItem>()
    lookup.mockReturnValueOnce(read.promise)
    const binding = capture()
    cache.operation(row, binding, { state: 'closed' })(true)
    const add = (label: string) => cache.operation(row, binding, { labels: { [label]: true } })
    const b = add('b')
    read.reject(unsupported())
    await flush()
    expect(cache.canTrack(binding)).toBe(false)
    const c = add('c')
    const view = () => cache.projectItem(copy())
    expect(view()).toMatchObject({ state: 'closed', labels: ['b', 'c'] })
    expect(b(true).labels).toEqual(['b', 'c'])
    expect(view().labels).toEqual(['b', 'c'])
    expect(c(false)).toMatchObject({ state: 'closed', labels: ['b'] })
    expect(copy()).toMatchObject({ state: 'closed', labels: ['b'] })
    expect(view()).toBe(copy())
    expect(cache.canTrack(binding, row)).toBe(false)
    await flush()
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

  it('keeps the PR body result through a compound metadata update', async () => {
    const { store } = setup()
    const cacheKey = projectViewCacheKey('organization', 'acme', 1, 'v')
    const source = projectRow()
    store.setState({
      projectViewCache: {
        [cacheKey]: {
          data: board([
            {
              ...source,
              itemType: 'PULL_REQUEST',
              content: { ...source.content, url: 'https://github.com/acme/widgets/pull/42' }
            }
          ]),
          fetchedAt: 1
        }
      }
    })
    const body =
      '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    Object.assign(mockApi.gh, {
      updatePullRequestBySlug: vi.fn().mockResolvedValue({
        ok: true,
        bodyImageUrls: {
          'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
            'https://private-user-images.githubusercontent.com/1/image.png?jwt=TEST'
        }
      })
    })
    mockApi.gh.updateIssueBySlug.mockResolvedValue({ ok: true })
    const result = await store
      .getState()
      .patchProjectIssueOrPr(cacheKey, 'r', { body, addLabels: ['bug'] })
    expect(result).toEqual({
      ok: true,
      bodyImageUrls: {
        'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
          'https://private-user-images.githubusercontent.com/1/image.png?jwt=TEST'
      }
    })
    expect(mockApi.gh.updateIssueBySlug).toHaveBeenCalledWith(
      expect.objectContaining({ updates: { addLabels: ['bug'] } })
    )
  })
})
