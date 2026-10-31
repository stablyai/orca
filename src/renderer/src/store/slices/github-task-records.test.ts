import { setRuntimeEnvironmentConnectionGenerationForTests } from './runtime-status-connection-generation'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitHubProjectTable } from '../../../../shared/github/project-types'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'
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
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
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
      const a = cache.operation(row, binding, (base) => ({
        ...base,
        assignees: [...(base.assignees ?? []), user]
      }))
      const b = cache.operation(row, binding, (base) => ({
        ...base,
        labels: [...base.labels, 'bug']
      }))
      a(true)
      a(true)
      expect(lookup).not.toHaveBeenCalled()
      expect(cache.projectItem(row, binding).assignees).toEqual([user])
      b(success)
      expect(lookup).toHaveBeenCalledTimes(1)
      expect(cache.projectItem(row, binding).labels).toEqual(success ? ['bug'] : [])
      canonical.resolve({
        ...row,
        assignees: [user],
        labels: success ? ['bug'] : [],
        updatedAt: '2026-10-31T12:00:03Z'
      })
      await flush()
      expect(cache.projectItem(row, binding).assignees).toEqual([user])
    }
  )

  it('rejects pre-edit canonical C and coalesces one replacement after B settles', async () => {
    const { cache, binding } = setup()
    const c = deferred<GitHubWorkItem>()
    const c2 = deferred<GitHubWorkItem>()
    lookup.mockReturnValue(c2.promise)
    const read = cache.readCanonical(row, binding, () => c.promise)
    const b = cache.operation(row, binding, (base) => ({ ...base, labels: ['new'] }))
    b(true)
    expect(lookup).not.toHaveBeenCalled()
    c.resolve(row)
    expect(await read).toBe(false)
    expect(lookup).toHaveBeenCalledTimes(1)
    c2.resolve({ ...row, labels: ['new'] })
    await flush()
    expect(cache.projectItem(row, binding).labels).toEqual(['new'])
  })

  it('serializes full and light reads and allows a same-second external reversal', async () => {
    const { cache, binding } = setup()
    const first = deferred<GitHubWorkItem>()
    lookup.mockReturnValue(first.promise)
    const edit = cache.operation(row, binding, (base) => ({ ...base, assignees: [user] }))
    edit(true)
    const full = vi.fn(async () => row)
    const refresh = cache.readCanonical(row, binding, full)
    expect(full).not.toHaveBeenCalled()
    first.resolve({ ...row, assignees: [user] })
    expect(await refresh).toBe(true)
    expect(full).toHaveBeenCalledTimes(1)
    expect(cache.projectItem(row, binding).assignees).toEqual([])
  })

  it('keeps failed canonical data, retries on the next conflicting search and adopts recovery', async () => {
    const { cache, binding } = setup()
    lookup.mockRejectedValueOnce(new Error('offline'))
    const edit = cache.operation(row, binding, (base) => ({ ...base, labels: ['confirmed'] }))
    edit(true)
    await flush()
    expect(cache.hasFailed(row, binding)).toBe(true)
    const external = { ...row, labels: ['outside'], updatedAt: '2026-10-31T12:00:03Z' }
    lookup.mockResolvedValueOnce(external)
    expect(cache.acceptSearch([external], binding)[0].labels).toEqual(['confirmed'])
    await flush()
    expect(cache.projectItem(row, binding).labels).toEqual(['outside'])
    expect(cache.hasFailed(row, binding)).toBe(false)
    expect(lookup).toHaveBeenCalledTimes(2)
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
    expect(cache.projectItem(row, binding).title).toBe('Newer')
  })

  it('retires relevant confirmed masks while preserving unrelated PR controls', async () => {
    const { cache, binding } = setup()
    setConfirmedListSnapshot(null, row.repoId, row.id, 'assignees', [user])
    setLastConfirmedClientValue(null, row.repoId, row.id, 'state', 'closed')
    setLastConfirmedClientValue(null, row.repoId, row.id, 'autoMerge', true)
    await cache.readCanonical(row, binding, async () => row)
    const merged = getRegistryMergedTaskPageGitHubWorkItem(cache.projectItem(row, binding), null)
    expect(merged.assignees).toEqual([])
    expect(merged.state).toBe('open')
    expect(merged.autoMergeEnabled).toBe(true)
  })

  it('disposes an account incarnation and rejects its deferred result after A to B to A', async () => {
    const { store, cache, binding } = setup()
    const old = cache.acceptSearch([row], binding)[0]
    const response = deferred<GitHubWorkItem>()
    const read = cache.readCanonical(row, binding, () => response.promise)
    const listener = vi.fn()
    cache.subscribe(listener)
    store.setState({ repos: [{ ...repo, ghAccount: { host: 'github.com', user: 'bob' } }] })
    store.setState({ repos: [repo] })
    response.resolve({ ...row, title: 'Old Alice' })
    expect(await read).toBe(false)
    expect(cache.isObservedCurrent(old)).toBe(false)
    expect(cache.current(binding)).toBe(false)
    expect(listener).toHaveBeenCalled()
    expect(cache.capture(repo)!.incarnation).not.toBe(binding.incarnation)
  })

  it('isolates host-qualified issue identities and bindings with the same issue number', async () => {
    const { cache, binding } = setup()
    await cache.readCanonical(row, binding, async () => ({ ...row, title: 'Confirmed' }))
    const enterprise = { ...row, url: 'https://ghe.example:8443/acme/widgets/issues/42' }
    expect(cache.projectItem(enterprise, binding).title).toBe('Original')
  })

  it('retains a visible pinned row during bounded eviction without extra reads for unrelated rows', async () => {
    const { cache, binding } = setup()
    const visible = cache.acceptSearch([row], binding)[0]
    const unpin = cache.pinObserved(visible)
    await cache.readCanonical(row, binding, async () => ({ ...row, title: 'Visible' }))
    for (let n = 100; n < 620; n++) {
      const item = {
        ...row,
        id: `issue:${n}`,
        number: n,
        url: `https://github.com/acme/widgets/issues/${n}`
      }
      await cache.readCanonical(item, binding, async () => item)
    }
    expect(cache.projectObserved(visible).title).toBe('Visible')
    expect(lookup).not.toHaveBeenCalled()
    unpin()
  })

  it('keeps legacy servers without a safe item route on simple confirmed patches', () => {
    const { store, cache, binding } = setup()
    Object.assign(mockApi.gh, { workItemByOwnerRepo: undefined })
    const patch = vi.spyOn(store.getState(), 'patchWorkItem')
    const edit = cache.operation(row, binding, (base) => ({ ...base, assignees: [user] }))
    edit(true)
    expect(patch).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({ assignees: [user] }),
      row.repoId,
      expect.anything()
    )
    expect(lookup).not.toHaveBeenCalled()
    expect(cache.hasFailed(row, binding)).toBe(false)
  })

  it('projects only issue facts into another account board, preserving board data and ambiguity', async () => {
    const bobRepo = { ...repo, id: 'bob-repo', ghAccount: { host: 'github.com', user: 'bob' } }
    const { cache, binding } = setup([repo, bobRepo])
    const source = projectRow()
    const table = cache.observeProject(board([source]), { kind: 'local' })
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
    const projected = cache.projectObservedTable(table).rows[0]
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
      const table = cache.observeProject(board([changed]), { kind: 'local' })
      await cache.readCanonical(row, binding, async () => ({ ...row, title: 'Confirmed' }))
      expect(cache.projectObservedTable(table).rows[0].content.title).toBe('Indexed')
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
    lookup.mockRejectedValueOnce(
      new RuntimeRpcCallError({
        id: 'old-server',
        ok: false,
        error: { code: 'method_not_found', message: 'unsupported' }
      })
    )
    cache.operation(row, binding, (base) => ({ ...base, labels: ['first'] }))(true)
    await flush()
    expect(cache.canTrack(binding)).toBe(false)
    expect(cache.hasFailed(row, binding)).toBe(false)
    expect(
      cache.operation(row, binding, (base) => ({ ...base, labels: ['next'] }))(true)?.labels
    ).toEqual(['next'])
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('removes disposed Project projections and preserves local board fields', async () => {
    const { store, cache, binding } = setup()
    const raw = board([projectRow()])
    const observed = cache.observeProject(raw, { kind: 'local' })
    await cache.readCanonical(row, binding, async () => ({ ...row, title: 'Confirmed' }))
    const projected = cache.projectObservedTable(observed)
    const moved = cache.copyProjectTable(projected, {
      ...projected,
      rows: [{ ...projected.rows[0], position: 9 }]
    })
    store.setState({ repos: [{ ...repo, ghAccount: { host: 'github.com', user: 'bob' } }] })
    const released = cache.projectObservedTable(moved)
    expect(released.rows[0].content.title).toBe('Indexed')
    expect(released.rows[0].position).toBe(9)
  })
  it('disposes deferred rows and reads on a connection incarnation change', async () => {
    setRuntimeEnvironmentConnectionGenerationForTests('p34245-test', 1)
    const remote = { ...repo, executionHostId: 'runtime:p34245-test' }
    const { store, cache, binding } = setup([remote])
    const observed = cache.acceptSearch([row], binding)[0]
    const response = deferred<GitHubWorkItem>()
    const read = cache.readCanonical(row, binding, () => response.promise)
    const listener = vi.fn()
    cache.subscribe(listener)
    setRuntimeEnvironmentConnectionGenerationForTests('p34245-test', 2)
    store.setState({ runtimeStatusByEnvironmentId: new Map() })
    response.resolve({ ...row, title: 'Old connection' })
    expect(await read).toBe(false)
    expect(cache.isObservedCurrent(observed)).toBe(false)
    expect(listener).toHaveBeenCalled()
  })
})
