import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitHubProjectTable } from '../../../../shared/github/project-types'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'
import { getTaskPageRepoSourceContext } from '@/lib/task-repo-source-context'
import { projectViewCacheKey } from '../github/cache-identity'
import { getRegistryMergedTaskPageGitHubWorkItem } from '@/components/task-page/github/task-page-github-work-item-mutation-composition'
import {
  setConfirmedListSnapshot,
  setLastConfirmedClientValue,
  resetTaskPageGitHubMutationRegistryForTests
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

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
    (
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
const storedLabels = (store: ReturnType<typeof createTestStore>) =>
  Object.values(store.getState().workItemsCache).map((entry) => entry.data?.[0]?.labels)
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
function freshBoardRow(): GitHubProjectTable['rows'][number] {
  const source = projectRow()
  return {
    ...source,
    content: {
      ...source.content,
      title: 'Renamed on GitHub',
      state: 'CLOSED',
      labels: [{ name: 'triaged', color: 'abcdef' }]
    }
  }
}
function boardFacts(table: GitHubProjectTable) {
  const { title, state, labels } = table.rows[0].content
  return { title, state, labels: labels.map((label) => label.name) }
}
function taskFacts(item: GitHubWorkItem) {
  return { title: item.title, state: item.state, labels: item.labels }
}
/** A board in the Project view cache, read back the way the board renders it. */
function cachedBoard(store: ReturnType<typeof createTestStore>) {
  const cacheKey = projectViewCacheKey('organization', 'acme', 1, 'v')
  store.setState({
    projectViewCache: { [cacheKey]: { data: board([freshBoardRow()]), fetchedAt: 1 } }
  })
  const shown = () =>
    boardFacts(
      store
        .getState()
        .githubTaskCache.projectTable(store.getState().projectViewCache[cacheKey].data!, 'local')
    )
  return { cacheKey, shown }
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

  it.each([true, false])(
    'folds confirmed assignee A once while label B settles (%s), then verifies',
    async (success) => {
      const { cache, binding } = setup()
      const canonical = deferred<GitHubWorkItem>()
      lookup.mockReturnValue(canonical.promise)
      const a = cache.operation(row, binding, { assignees: { alice: user } })
      const b = cache.operation(row, binding, { labels: { bug: true } })
      a(true)
      a(true)
      expect(lookup).not.toHaveBeenCalled()
      expect(cache.projectItem(row).assignees).toEqual([user])
      b(success)
      expect(lookup).toHaveBeenCalledTimes(1)
      expect(cache.projectItem(row).labels).toEqual(success ? ['bug'] : [])
      canonical.resolve({
        ...row,
        assignees: [user],
        labels: success ? ['bug'] : [],
        updatedAt: '2026-10-31T12:00:03Z'
      })
      await flush()
      expect(cache.projectItem(row).assignees).toEqual([user])
    }
  )

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
    expect(lookup).toHaveBeenCalledTimes(1)
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
    expect(full).toHaveBeenCalledTimes(1)
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

  it('isolates host-qualified issue identities and bindings with the same issue number', async () => {
    const { cache, binding } = setup()
    await cache.readCanonical(row, binding, async () => ({ ...row, title: 'Confirmed' }))
    const enterprise = { ...row, url: 'https://ghe.example:8443/acme/widgets/issues/42' }
    expect(cache.projectItem(enterprise).title).toBe('Original')
  })

  it('treats presentation-only differences as the same reading and never records pull requests', async () => {
    const { cache, binding } = setup()
    await cache.readCanonical(row, binding, async () => ({ ...row, assignees: [user] }))
    const enriched = {
      ...row,
      authorAvatarUrl: 'https://avatars.example/u/1?s=48&v=4',
      assignees: [{ ...user, name: 'Alice Profile', avatarUrl: 'alice-48.png' }]
    }
    expect(cache.acceptSearch([enriched], binding)[0]).toBe(enriched)
    expect(lookup).not.toHaveBeenCalled()
    const pr = {
      ...row,
      id: 'pr:7',
      type: 'pr' as const,
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7'
    }
    expect(cache.operation(pr, binding, { state: 'merged' })(true).state).toBe('merged')
    expect(await cache.readCanonical(pr, binding, async () => pr)).toBe(false)
    expect(cache.projectItem({ ...pr, state: 'merged' }).state).toBe('merged')
  })

  it('serves a verification joined to a discarded Refresh read with exactly one item read', async () => {
    const { cache, binding } = setup()
    await cache.readCanonical(row, binding, async () => row)
    const full = deferred<GitHubWorkItem | null>()
    const refresh = cache.readCanonical(row, binding, () => full.promise)
    await flush()
    cache.acceptSearch([{ ...row, title: 'Same second' }], binding)
    expect(lookup).not.toHaveBeenCalled()
    full.resolve(null)
    expect(await refresh).toBe(false)
    await flush()
    expect(lookup).toHaveBeenCalledTimes(1)
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

  it.each(['REDACTED', 'DRAFT_ISSUE', 'enterprise', 'hostless'] as const)(
    'does not project into ineligible Project content (%s)',
    async (kind) => {
      const { cache, binding } = setup()
      const source = projectRow()
      const changed =
        kind === 'enterprise'
          ? {
              ...source,
              content: { ...source.content, url: 'https://ghe.example/acme/widgets/issues/42' }
            }
          : kind === 'hostless'
            ? { ...source, content: { ...source.content, url: '/acme/widgets/issues/42' } }
            : { ...source, itemType: kind }
      await cache.readCanonical(row, binding, async () => ({ ...row, title: 'Confirmed' }))
      expect(cache.projectTable(board([changed]), 'local').rows[0].content.title).toBe('Indexed')
    }
  )
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
    const result = await store
      .getState()
      .fetchWorkItemsNextPage([{ repoId: repo.id, path: repo.path }], 20, 20, '', 2)
    expect(result.items[0].labels).toEqual(['current'])
    mockApi.gh.listWorkItems.mockResolvedValue({
      items: [],
      sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    })
    expect(
      (
        await store
          .getState()
          .fetchWorkItemsNextPage([{ repoId: repo.id, path: repo.path }], 20, 20, '', 3)
      ).items
    ).toEqual([])
  })

  it('drops unsupported-read obligations once, preserving confirmed patches and allowing more edits', async () => {
    const { cache, binding } = setup()
    lookup.mockRejectedValueOnce(unsupported())
    cache.operation(row, binding, { labels: { first: true } })(true)
    await flush()
    expect(cache.canTrack(binding)).toBe(false)
    expect(cache.operation(row, binding, { labels: { next: true } })(true).labels).toEqual(['next'])
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])(
    'folds a Projects-row label edit into the record and the projected board (%s)',
    async (success) => {
      const { cache, binding } = setup()
      await cache.readCanonical(row, binding, async () => ({ ...row, labels: ['original'] }))
      const table = board([projectRow()])
      const finish = cache.projectOperation(
        table.rows[0],
        table.project.host,
        { kind: 'local' },
        { addLabels: ['bug'] }
      )
      const labels = () =>
        cache.projectTable(table, 'local').rows[0].content.labels.map((l) => l.name)
      expect(labels()).toEqual(['original', 'bug'])
      expect(cache.projectItem(row).labels).toEqual(['original', 'bug'])
      finish(success)
      expect(labels()).toEqual(success ? ['original', 'bug'] : ['original'])
      expect(cache.projectItem(row).labels).toEqual(success ? ['original', 'bug'] : ['original'])
    }
  )
  it('verifies conflicting board rows once per fetch, never from truncation or re-render', async () => {
    const { store, cache, binding } = setup()
    const labels = Array.from({ length: 11 }, (_, n) => `label-${n}`)
    const confirmed = { ...row, title: 'Confirmed', labels, assignees: [user] }
    await cache.readCanonical(row, binding, async () => confirmed)
    const truncated = projectRow()
    truncated.content = {
      ...truncated.content,
      title: 'Confirmed',
      labels: labels.slice(0, 10).map((name) => ({ name, color: 'abcdef' }))
    }
    cache.observeProject(board([truncated]), { kind: 'local' })
    expect(cache.projectTable(board([truncated]), 'local').rows[0]).toBe(truncated)
    expect(lookup).not.toHaveBeenCalled()
    lookup.mockResolvedValue(confirmed)
    for (let fetch = 1; fetch <= 2; fetch++) {
      const stale = board([projectRow()])
      cache.observeProject(stale, { kind: 'local' })
      await flush()
      for (let render = 0; render < 3; render++) {
        expect(cache.projectTable(stale, 'local').rows[0].content.title).toBe('Confirmed')
      }
      expect(lookup).toHaveBeenCalledTimes(fetch)
    }
    store.setState({ repos: [{ ...repo, ghAccount: { host: 'github.com', user: 'bob' } }] })
    expect(cache.projectTable(board([projectRow()]), 'local').rows[0].content.title).toBe('Indexed')
  })
  it.each([false, true])(
    'shows a Project edit only as its own change on every copy until a reading is accepted (ok %s)',
    async (ok) => {
      const { store, cache } = setup()
      const { copy, search } = await tasksRow(store)
      const { cacheKey, shown } = cachedBoard(store)
      const tasks = () => taskFacts(cache.projectItem(copy()))
      const update = deferred<{ ok: boolean }>()
      mockApi.gh.updateIssueBySlug.mockReturnValue(update.promise)
      const verification = deferred<GitHubWorkItem>()
      lookup.mockReturnValueOnce(verification.promise)
      const edit = store.getState().patchProjectIssueOrPr(cacheKey, 'r', { addLabels: ['bug'] })
      const board = { title: 'Renamed on GitHub', state: 'CLOSED', labels: ['triaged', 'bug'] }
      const taskRow = { title: 'Original', state: 'open', labels: ['bug'] }
      expect(shown()).toEqual(board)
      expect(tasks()).toEqual(taskRow)
      update.resolve({ ok })
      await edit
      await flush()
      if (!ok) {
        expect(shown()).toEqual({ ...board, labels: ['triaged'] })
        expect(tasks()).toEqual({ ...taskRow, labels: [] })
        expect(copy().labels).toEqual([])
        expect(lookup).not.toHaveBeenCalled()
        return
      }
      // Delayed, then failed verification: each copy keeps its own facts plus only the edit.
      expect(lookup).toHaveBeenCalledOnce()
      expect([shown(), tasks()]).toEqual([board, taskRow])
      verification.reject(new Error('offline'))
      await flush()
      expect([shown(), tasks()]).toEqual([board, taskRow])
      // A stale search can't erase the confirmed change; it wakes the owed read, whose answer then wins.
      const truth = {
        ...row,
        title: 'Renamed on GitHub',
        state: 'closed' as const,
        labels: ['triaged', 'bug']
      }
      lookup.mockResolvedValueOnce({ ...truth, updatedAt: '2026-10-31T12:00:05Z' })
      expect((await search()).labels).toEqual(['bug'])
      await flush()
      expect(lookup).toHaveBeenCalledTimes(2)
      expect(tasks()).toEqual(taskFacts(truth))
      expect(shown()).toEqual(board)
    }
  )
  it('installs nothing from a first Refresh while it runs or after it fails', async () => {
    const { store, cache } = setup()
    const { copy, capture } = await tasksRow(store)
    const table = board([freshBoardRow()])
    const response = deferred<GitHubWorkItem | null>()
    const refresh = cache.readCanonical(copy(), capture(), () => response.promise)
    expect(cache.projectTable(table, 'local')).toBe(table)
    expect(cache.projectItem(copy())).toBe(copy())
    response.resolve(null)
    expect(await refresh).toBe(false)
    cache.observeProject(table, { kind: 'local' })
    await flush()
    expect(cache.projectTable(table, 'local')).toBe(table)
    expect(lookup).not.toHaveBeenCalled()
  })
  it('establishes from the read after the last of two overlapping edits', async () => {
    const { store, cache } = setup()
    const { capture } = await tasksRow(store)
    const r1 = deferred<GitHubWorkItem>(),
      r2 = deferred<GitHubWorkItem>()
    lookup.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise)
    cache.operation(row, capture(), { labels: { a: true } })(true)
    cache.operation(row, capture(), { labels: { b: true } })(true)
    expect(lookup).toHaveBeenCalledOnce()
    r1.resolve({ ...row, labels: ['a'], updatedAt: '2026-10-31T12:00:03Z' })
    await flush()
    expect(lookup).toHaveBeenCalledTimes(2)
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
    expect(lookup).toHaveBeenCalledTimes(2)
  })
  it('wakes an owner without a base from the next board fetch, never from renders', async () => {
    const { store, cache } = setup()
    const { capture } = await tasksRow(store)
    lookup.mockRejectedValueOnce(new Error('offline'))
    cache.operation(row, capture(), { labels: { bug: true } })(true)
    await flush()
    for (let render = 0; render < 3; render++) {
      cache.projectTable(board([freshBoardRow()]), 'local')
    }
    expect(lookup).toHaveBeenCalledOnce()
    lookup.mockResolvedValueOnce({ ...row, title: 'Renamed on GitHub', labels: ['bug'] })
    cache.observeProject(board([freshBoardRow()]), { kind: 'local' })
    await flush()
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(cache.projectItem(row).title).toBe('Renamed on GitHub')
  })
  it('keeps a body-only Project save out of the record: no metadata change and no read', async () => {
    const { store, cache } = setup()
    const { copy, capture } = await tasksRow(store)
    const { cacheKey, shown } = cachedBoard(store)
    const update = deferred<{ ok: boolean }>()
    mockApi.gh.updateIssueBySlug.mockReturnValue(update.promise)
    const board = shown()
    const edit = store.getState().patchProjectIssueOrPr(cacheKey, 'r', { body: 'New body' })
    expect(shown()).toEqual(board)
    expect(cache.projectItem(copy())).toBe(copy())
    update.resolve({ ok: true })
    await edit
    await flush()
    expect(store.getState().projectViewCache[cacheKey].data!.rows[0].content.body).toBe('New body')
    expect(shown()).toEqual(board)
    expect(cache.readRevision(row, capture())).toBe(0)
    expect(lookup).not.toHaveBeenCalled()
  })
  it.each([
    ['close', true, false],
    ['close', false, false],
    ['label', true, false],
    ['label', false, false],
    ['close', false, true],
    ['label', false, true]
  ] as const)(
    'settles a disposed owner through its reducer (%s first, label ok %s, accepted base %s)',
    async (first, labelOk, accepted) => {
      const { store, cache } = setup()
      const { copy, capture } = await tasksRow(store)
      if (accepted) {
        await cache.readCanonical(row, capture(), async () => row)
      }
      const close = cache.operation(row, capture(), { state: 'closed' })
      const label = cache.operation(row, capture(), { labels: { bug: true } })
      expect(cache.projectItem(copy())).toMatchObject({ state: 'closed', labels: ['bug'] })
      rebind(store)
      const settles =
        first === 'close'
          ? [() => close(true), () => label(labelOk)]
          : [() => label(labelOk), () => close(true)]
      expect(settles[0]().state).toBe('closed')
      expect(settles[1]()).toMatchObject({ state: 'closed', labels: labelOk ? ['bug'] : [] })
      expect(copy()).toMatchObject({ state: 'closed', labels: labelOk ? ['bug'] : [] })
      expect(close(true)).toMatchObject({ state: 'closed', labels: labelOk ? ['bug'] : [] })
      await flush()
      expect(lookup).not.toHaveBeenCalled()
    }
  )
  it.each([false, true])(
    'removes only the failed member of disjoint list edits after disposal (accepted base %s)',
    async (accepted) => {
      const { store, cache } = setup()
      const { copy, capture } = await tasksRow(store)
      if (accepted) {
        await cache.readCanonical(row, capture(), async () => row)
      }
      const a = cache.operation(row, capture(), { labels: { a: true } })
      const b = cache.operation(row, capture(), { labels: { b: true } })
      rebind(store)
      // A member the copy gained after disposal is not this owner's to remove.
      store.getState().patchWorkItem(row.id, (current) => ({ labels: [...current.labels, 'x'] }))
      expect(a(false).labels).toEqual(['b'])
      expect(b(true).labels).toEqual(['b'])
      expect([...copy().labels].sort()).toEqual(['b', 'x'])
    }
  )
  it('leaves copies to a replacement incarnation and reconciles them with its own read', async () => {
    const { store, cache } = setup()
    const { copy, capture } = await tasksRow(store)
    await cache.readCanonical(row, capture(), async () => row)
    const old = cache.operation(row, capture(), { labels: { old: true } })
    expect(copy().labels).toEqual([])
    rebind(store)
    const next = cache.operation(copy(), capture(), { labels: { new: true } })
    expect(cache.projectItem(copy()).labels).toEqual(['new'])
    expect(old(false).labels).toEqual([])
    lookup.mockResolvedValue({ ...row, title: 'Reconciled', updatedAt: '2026-10-31T12:00:03Z' })
    next(false)
    await flush()
    // The late old settlement owes the replacement its own read, even though its own edit failed.
    expect(lookup).toHaveBeenCalledOnce()
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
    expect(lookup).toHaveBeenCalledOnce()
  })
  it.each(['source', 'enterprise'] as const)(
    'leaves Tasks copies alone for a Project edit on another %s',
    async (kind) => {
      const { store } = setup()
      const { copy } = await tasksRow(store)
      const source = projectRow()
      const changed =
        kind === 'enterprise'
          ? {
              ...source,
              content: { ...source.content, url: 'https://ghe.example/acme/widgets/issues/42' }
            }
          : source
      store
        .getState()
        .githubTaskCache.projectOperation(
          changed,
          undefined,
          kind === 'source' ? { kind: 'environment', environmentId: 'other' } : { kind: 'local' },
          { addLabels: ['bug'] }
        )(true)
      await flush()
      expect(store.getState().githubTaskCache.projectItem(copy()).labels).toEqual([])
      expect(lookup).not.toHaveBeenCalled()
    }
  )
  it.each([false, true])(
    "keeps a newer reading when an old accepted owner's add settles after disposal (ok %s)",
    async (ok) => {
      const { store, cache } = setup()
      const { copy, capture } = await tasksRow(store)
      const logins = (item: GitHubWorkItem) => item.assignees?.map((u) => u.login)
      await cache.readCanonical(row, capture(), async () => row)
      const settle = cache.operation(row, capture(), { assignees: { alice: user } })
      expect(logins(cache.projectItem(copy()))).toEqual(['alice'])
      expect(logins(copy())).toEqual([])
      rebind(store)
      mockApi.gh.listWorkItems.mockResolvedValue({
        items: [{ ...row, assignees: [user], updatedAt: '2026-10-31T12:10:00Z' }],
        sources
      })
      await store.getState().fetchWorkItems(repo.id, repo.path, 20, '', {
        sourceContext: getTaskPageRepoSourceContext(repo, 'github'),
        force: true
      })
      expect(logins(settle(ok))).toEqual(ok ? ['alice'] : [])
      expect(logins(copy())).toEqual(['alice'])
      expect(lookup).not.toHaveBeenCalled()
    }
  )
  it.each([false, true])(
    "never stores an accepted owner's pending change from a search during the edit (ok %s)",
    async (ok) => {
      const { store, cache } = setup()
      const { copy, capture, search } = await tasksRow(store)
      await cache.readCanonical(row, capture(), async () => row)
      const settle = cache.operation(row, capture(), { labels: { bug: true } })
      expect((await search()).labels).toEqual([])
      expect(copy().labels).toEqual([])
      expect(cache.projectItem(copy()).labels).toEqual(['bug'])
      lookup.mockResolvedValue({ ...row, labels: ['bug'], updatedAt: '2026-10-31T12:00:03Z' })
      settle(ok)
      expect(copy().labels).toEqual(ok ? ['bug'] : [])
      expect(cache.projectItem(copy()).labels).toEqual(ok ? ['bug'] : [])
      await flush()
      expect(lookup).toHaveBeenCalledTimes(ok ? 1 : 0)
    }
  )
  it('lets a Refresh queued behind a discarded one read once that owner retires', async () => {
    const { cache, binding } = setup()
    const first = deferred<GitHubWorkItem | null>()
    const r1 = cache.readCanonical(row, binding, () => first.promise)
    const second = vi.fn(async () => ({ ...row, title: 'Fresh' }))
    const r2 = cache.readCanonical(row, binding, second)
    first.resolve(null)
    expect([await r1, await r2]).toEqual([false, true])
    expect(second).toHaveBeenCalledOnce()
    expect(cache.projectItem(row).title).toBe('Fresh')
  })
  it.each(['binding', 'support'] as const)(
    'ends a queued Refresh without reading or leaving an owner when %s is lost during its wait',
    async (lost) => {
      const { store, cache, binding } = setup()
      const first = deferred<GitHubWorkItem | null>()
      const r1 = cache.readCanonical(row, binding, () => first.promise)
      const second = vi.fn(async () => ({ ...row, title: 'Fresh' }))
      const r2 = cache.readCanonical(row, binding, second)
      if (lost === 'binding') {
        rebind(store)
        first.resolve(null)
      } else {
        first.reject(unsupported())
      }
      expect([await r1, await r2]).toEqual([false, false])
      expect(second).not.toHaveBeenCalled()
      const table = board([freshBoardRow()])
      cache.observeProject(table, { kind: 'local' })
      expect(cache.projectTable(table, 'local')).toBe(table)
      expect(lookup).not.toHaveBeenCalled()
    }
  )
  it.each([false, true])(
    'keeps Project edits board-only on a server known to lack the item route (ok %s)',
    async (ok) => {
      const { store, cache } = setup()
      const sourceContext = getTaskPageRepoSourceContext(repo, 'github')
      const { capture } = await tasksRow(store)
      mockApi.gh.listWorkItems.mockResolvedValueOnce({
        items: [{ ...row, labels: ['bug'], updatedAt: '2026-10-31T12:10:00Z' }],
        sources
      })
      await store.getState().fetchWorkItems(repo.id, repo.path, 20, 'is:open', { sourceContext })
      await cache.readCanonical(row, capture(), () => Promise.reject(unsupported()))
      const { cacheKey } = cachedBoard(store)
      const before = storedLabels(store)
      expect(before).toEqual([[], ['bug']])
      mockApi.gh.updateIssueBySlug.mockResolvedValue(
        ok ? { ok: true } : { ok: false, error: 'nope' }
      )
      await store.getState().patchProjectIssueOrPr(cacheKey, 'r', { addLabels: ['bug'] })
      await flush()
      expect(storedLabels(store)).toEqual(before)
      expect(lookup).not.toHaveBeenCalled()
    }
  )
})
