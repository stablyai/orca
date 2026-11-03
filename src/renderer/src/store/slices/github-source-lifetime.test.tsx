// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'
import { mergeFetchedRepoCatalog, type FetchedRepoCatalog } from '../repos/repo-catalog-merge'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { createRepoUpdateActions } from '../repos/repo-update'
import { findTaskPageDialogWorkItem } from '@/components/task-page/task-page-dialog-work-item'
import { getTaskPageRepoSourceContext } from '@/components/task-page/task-page-source-context'
import { taskPageGitHubResumeCache } from '@/components/task-page/github/task-page-github-resume-cache'
import { createCmdJTaskSearchRequests } from '@/components/cmd-j/task-search-requests'
import { EMPTY_PALETTE_FILTER } from '@/components/cmd-j/palette-filter'
import { githubTaskBinding } from '@/lib/github-task-observation'
import { bindingKey } from '../github/task-record-model'
import type { AppState } from '../types'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { Repo } from '../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

const holder = vi.hoisted((): { store: ReturnType<typeof createTestStore> | null } => ({
  store: null
}))
vi.mock('@/store/index', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: AppState) => T) => useStore(holder.store!, selector),
    {
      getState: () => holder.store!.getState(),
      subscribe: (listener: (state: AppState) => void) => holder.store!.subscribe(listener)
    }
  )
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const origin = { owner: 'fork', repo: 'project' }
const upstream = { owner: 'parent', repo: 'project' }
const repo: Repo = {
  id: 'source-repo',
  path: '/source-repo',
  displayName: 'Project',
  addedAt: 1,
  badgeColor: '',
  executionHostId: 'local'
}
function row(owner: string, number = 12): GitHubWorkItem {
  return {
    id: `issue:${number}`,
    repoId: repo.id,
    type: 'issue',
    number,
    title: owner,
    state: 'open',
    url: `https://github.com/${owner}/project/issues/${number}`,
    author: null,
    labels: [],
    assignees: [],
    updatedAt: '2026-11-01T00:00:00Z'
  }
}
const envelope = (owner: string) => ({
  items: [row(owner)],
  sources: {
    issues: { owner, repo: 'project' },
    prs: { owner, repo: 'project' },
    originCandidate: origin,
    upstreamCandidate: upstream
  }
})
const args = [{ repoId: repo.id, path: repo.path }]
const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }
}
function setup() {
  const store = createTestStore()
  store.setState({
    repos: [repo],
    projects: [],
    projectHostSetups: [],
    settings: createGlobalSettingsFixture(),
    fetchReposForAllHosts: vi.fn().mockResolvedValue(undefined),
    ...createRepoUpdateActions(store.setState, store.getState)
  })
  holder.store = store
  return store
}
beforeEach(() => {
  vi.stubGlobal('window', document.defaultView)
  Object.defineProperty(window, 'api', { configurable: true, value: mockApi })
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  mockApi.repos.update.mockResolvedValue(undefined)
  mockApi.gh.listWorkItems.mockResolvedValue(envelope('parent'))
})
afterEach(() => {
  cleanup()
  holder.store = null
})

describe('GitHub source collection lifetime', () => {
  it('detaches old rows at the optimistic click and never publishes a pre-ack response', async () => {
    const store = setup()
    await store.getState().fetchWorkItems(repo.id, repo.path, 20, '')
    const save = Promise.withResolvers<Repo>()
    mockApi.repos.update.mockReturnValue(save.promise)
    const pendingSave = store
      .getState()
      .setIssueSourcePreference(repo.id, repo.path, 'origin', 'local')
    const detached = store.getState().getCachedWorkItems(repo.id, 20, '', repo.path)
    const early = store.getState().fetchWorkItems(repo.id, repo.path, 20, '', { force: true })
    await flush()
    save.resolve({ ...repo, issueSourcePreference: 'origin' })
    await pendingSave
    expect(detached).toBeNull()
    expect(await early).toBeUndefined()
    expect(store.getState().getCachedWorkItems(repo.id, 20, '', repo.path)).toBeNull()
  })

  it('preserves the latest pressed value across intermediate A→B→A save replies', async () => {
    const store = setup()
    const catalog: FetchedRepoCatalog = {
      repos: [repo],
      reposAtRequest: [repo],
      hostId: 'local',
      projectHostSetupCompatibility: projectHostSetupProjectionFromRepos([repo]),
      sourceOwner: store.getState().githubSourceCollections,
      sourceWrites: store.getState().githubSourceCollections.catalogSnapshot()
    }
    const first = Promise.withResolvers<Repo>(),
      last = Promise.withResolvers<Repo>()
    mockApi.repos.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise)
    const b = store.getState().setIssueSourcePreference(repo.id, repo.path, 'origin', 'local')
    const a = store.getState().setIssueSourcePreference(repo.id, repo.path, 'upstream', 'local')
    first.resolve({ ...repo, issueSourcePreference: 'origin' })
    await b
    const intermediate = store.getState().repos[0].issueSourcePreference
    expect(
      mergeFetchedRepoCatalog(catalog, store.getState().repos).repos[0].issueSourcePreference
    ).toBe('upstream')
    last.resolve({ ...repo, issueSourcePreference: 'upstream' })
    await a
    expect(intermediate).toBe('upstream')
    expect(store.getState().repos[0].issueSourcePreference).toBe('upstream')
    expect(
      mergeFetchedRepoCatalog(catalog, store.getState().repos).repos[0].issueSourcePreference
    ).toBe('upstream')
  })

  it('rejects inverted A1/B/A2 list deliveries including page N', async () => {
    const store = setup()
    const a1 = Promise.withResolvers<ReturnType<typeof envelope>>()
    mockApi.gh.listWorkItems.mockReturnValueOnce(a1.promise)
    const old = store.getState().fetchWorkItems(repo.id, repo.path, 20, '')
    await flush()
    await store.getState().setIssueSourcePreference(repo.id, repo.path, 'origin', 'local')
    const b = Promise.withResolvers<ReturnType<typeof envelope>>()
    mockApi.gh.listWorkItems.mockReturnValueOnce(b.promise)
    const page = store.getState().fetchWorkItemsNextPage(args, 20, 20, '', 1)
    await flush()
    await store.getState().setIssueSourcePreference(repo.id, repo.path, 'upstream', 'local')
    mockApi.gh.listWorkItems.mockResolvedValueOnce(envelope('parent'))
    const a2 = await store.getState().fetchWorkItemsAcrossRepos(args, 20, 20, '')
    b.resolve(envelope('fork'))
    a1.resolve(envelope('parent'))
    expect(await old).toBeUndefined()
    expect(await page).toBeUndefined()
    expect(a2?.items.map((item) => item.url)).toEqual([row('parent').url])
    expect(
      store
        .getState()
        .getCachedWorkItems(repo.id, 20, '', repo.path)
        ?.map((item) => item.url)
    ).toEqual([row('parent').url])
  })

  it('detaches only the selected host when two copies share both id and path', async () => {
    const store = setup()
    const ssh = { ...repo, executionHostId: 'ssh:box' as const, connectionId: 'box' }
    store.setState({ repos: [repo, ssh] })
    const localSource = getTaskPageRepoSourceContext(repo, 'github')
    const sshSource = getTaskPageRepoSourceContext(ssh, 'github')
    await store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 20, '', { sourceContext: localSource })
    await store.getState().fetchWorkItems(repo.id, repo.path, 20, '', { sourceContext: sshSource })
    await store.getState().setIssueSourcePreference(ssh.id, ssh.path, 'origin', 'ssh:box')
    expect(store.getState().getCachedWorkItems(ssh.id, 20, '', ssh.path, sshSource)).toBeNull()
    expect(
      store.getState().getCachedWorkItems(repo.id, 20, '', repo.path, localSource)
    ).toHaveLength(1)
  })

  it('returns obsolete for a served-source contradiction rather than wrong-source rows', async () => {
    const store = setup()
    await store.getState().setIssueSourcePreference(repo.id, repo.path, 'origin', 'local')
    mockApi.gh.listWorkItems.mockResolvedValue(envelope('parent'))
    expect(await store.getState().fetchWorkItemsAcrossRepos(args, 20, 20, '')).toBeUndefined()
  })

  it('terminates a failed save and failed resync, restores the acknowledged choice, and permits retry', async () => {
    const store = setup()
    mockApi.repos.update.mockRejectedValueOnce(new Error('save rejected'))
    store.setState({ fetchReposForAllHosts: vi.fn().mockRejectedValue(new Error('resync failed')) })
    await store.getState().setIssueSourcePreference(repo.id, repo.path, 'origin', 'local')
    expect(store.getState().repos[0].issueSourcePreference).toBeUndefined()
    mockApi.gh.listWorkItems.mockResolvedValueOnce(envelope('parent'))
    expect(await store.getState().fetchWorkItems(repo.id, repo.path, 20, '')).toHaveLength(1)
    await store.getState().setIssueSourcePreference(repo.id, repo.path, 'upstream', 'local')
    expect(store.getState().repos[0].issueSourcePreference).toBe('upstream')
  })

  it('certifies Submit after a failed write only once the host row is read back', async () => {
    const store = setup()
    // The host may have committed origin although the acknowledgement was lost.
    mockApi.repos.update.mockRejectedValueOnce(new Error('request timed out'))
    const recovery = Promise.withResolvers<void>()
    store.setState({ fetchReposForAllHosts: vi.fn().mockReturnValue(recovery.promise) })
    const owner = store.getState().githubSourceCollections
    // A snapshot from before the failed save must not stand in for the readback's.
    const snapshots = [owner.catalogSnapshot()]
    await store.getState().setIssueSourcePreference(repo.id, repo.path, 'origin', 'local')
    const waiting = owner.awaitSave(store.getState().repos[0])
    await flush()
    recovery.reject(new Error('catalog unreachable'))
    const unverified = await waiting
    expect(unverified !== 'save-failed' && unverified()).toBe(false)
    const readBack = vi.fn(async () => {
      const started = owner.catalogSnapshot()
      // Every host request of one refresh shares one snapshot while ownership is unchanged.
      snapshots.push(started, owner.catalogSnapshot())
      store.setState((s) => ({ repos: s.repos.map((row) => owner.adopt({ ...row }, started)) }))
    })
    store.setState({ fetchReposForAllHosts: readBack })
    const ready = await owner.awaitSave(store.getState().repos[0])
    expect(readBack).toHaveBeenCalledTimes(1)
    expect(new Set(snapshots).size).toBe(2)
    expect(ready !== 'save-failed' && ready()).toBe(true)
  })

  it('retries contradiction recovery on a later refresh after the first catalog read failed', async () => {
    const store = setup()
    store.setState({ repos: [{ ...repo, issueSourcePreference: 'origin' }] })
    const resync = vi.fn().mockRejectedValue(new Error('temporary catalog outage'))
    store.setState({ fetchReposForAllHosts: resync })
    expect(
      await store.getState().fetchWorkItems(repo.id, repo.path, 20, '', { force: true })
    ).toBeUndefined()
    await flush()
    expect(
      await store.getState().fetchWorkItems(repo.id, repo.path, 20, '', { force: true })
    ).toBeUndefined()
    await flush()
    expect(resync).toHaveBeenCalledTimes(2)
  })

  it('keeps another repository delivery current when one owner retires its mapping', async () => {
    const store = setup()
    const other = { ...repo, id: 'other', path: '/other' }
    store.setState({ repos: [repo, other] })
    await store.getState().fetchWorkItems(repo.id, repo.path, 20, '')
    const held = Promise.withResolvers<ReturnType<typeof envelope>>()
    mockApi.gh.listWorkItems.mockReturnValueOnce(held.promise)
    const otherRows = store.getState().fetchWorkItems(other.id, other.path, 20, '')
    await flush()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      ...envelope('parent'),
      sources: { ...envelope('parent').sources, originCandidate: { owner: 'new-fork', repo: 'p' } }
    })
    await store.getState().fetchWorkItems(repo.id, repo.path, 20, 'label:new')
    held.resolve(envelope('parent'))
    expect(await otherRows).toHaveLength(1)
  })

  it('adopts a queued rename after an earlier queued account change replaced the owner', async () => {
    const store = setup()
    const bob = { host: 'github.com', user: 'bob' }
    const account = Promise.withResolvers<Repo>()
    mockApi.repos.update
      .mockReturnValueOnce(account.promise)
      .mockResolvedValueOnce({ ...repo, ghAccount: bob, displayName: 'New' })
    const switching = store.getState().updateRepo(repo.id, { ghAccount: bob })
    const renaming = store.getState().updateRepo(repo.id, { displayName: 'New' })
    account.resolve({ ...repo, ghAccount: bob })
    expect([await switching, await renaming]).toEqual([true, true])
    expect(store.getState().repos[0].displayName).toBe('New')
  })

  it.each([false, true])(
    'answers a Cmd-J search held by a source save once it settles, or starts nothing once cancelled (cancelled=%s)',
    async (cancelled) => {
      const store = setup()
      store.setState({ preflightStatusChecked: false })
      const save = Promise.withResolvers<Repo>()
      mockApi.repos.update.mockReturnValueOnce(save.promise)
      mockApi.gh.listWorkItems.mockResolvedValue(envelope('fork'))
      const saving = store
        .getState()
        .setIssueSourcePreference(repo.id, repo.path, 'origin', 'local')
      // Nothing may keep observing the held save once its searches are cancelled.
      const held = store
        .getState()
        .githubSourceCollections.catalogSnapshot()
        .get(bindingKey(repo))?.write
      if (!held) {
        throw new Error('expected the held source save')
      }
      const observe = vi.spyOn(held.settled, 'then')
      const search = () => {
        const controller = new AbortController()
        const [request] = createCmdJTaskSearchRequests({
          query: 'fork',
          repos: store.getState().repos,
          settings: createGlobalSettingsFixture({ visibleTaskProviders: ['github'] }),
          accountBackedTaskSourceHostId: 'local',
          filter: EMPTY_PALETTE_FILTER,
          hostLabels: new Map(),
          signal: controller.signal
        })
        return { controller, results: request.run().catch(() => undefined) }
      }
      const { controller, results } = search()
      await flush()
      expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
      if (cancelled) {
        controller.abort()
        for (let repeat = 0; repeat < 5; repeat++) {
          const again = search()
          await flush()
          again.controller.abort()
          await again.results
        }
        await results
        expect([observe.mock.calls.length, held.waiters.size]).toEqual([0, 0])
      }
      save.resolve({ ...repo, issueSourcePreference: 'origin' })
      await saving
      expect((await results)?.length).toBe(cancelled ? undefined : 1)
      expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(cancelled ? 0 : 1)
    }
  )

  it.each([3, 30])(
    'retires %i removed owners with one cache publication and one notification',
    async (k) => {
      const store = setup()
      const gone = Array.from({ length: k }, (_, i) => ({
        ...repo,
        id: `gone-${i}`,
        path: `/g${i}`
      }))
      store.setState({ repos: [repo, ...gone] })
      await store.getState().fetchWorkItems(repo.id, repo.path, 20, '')
      await store.getState().fetchWorkItems(gone[0].id, gone[0].path, 20, '')
      const owner = store.getState().githubSourceCollections
      const goneCount = owner.countKey([owner.capture(gone[0]).scope], '', 20)
      owner.answer(goneCount, [owner.capture(gone[0])], { totalCount: 1, totalPages: 1 }, '', 20)
      taskPageGitHubResumeCache.write('gone', 1, [row('parent')], undefined, [
        owner.context(gone[0])
      ])
      const counts = { notices: 0, publications: 0 }
      const stops = [
        owner.subscribe(() => counts.notices++),
        store.subscribe(() => counts.publications++)
      ]
      const cache = store.getState().workItemsCache
      store.setState({ repos: [repo, gone[0]] })
      expect(counts).toEqual({ notices: 1, publications: 2 })
      expect(store.getState().workItemsCache).toBe(cache)
      Object.assign(counts, { notices: 0, publications: 0 })
      store.setState({ repos: [repo] })
      stops.forEach((stop) => stop())
      expect(counts).toEqual({ notices: 1, publications: 2 })
      expect(Object.keys(store.getState().workItemsCache)).toHaveLength(1)
      expect(owner.count(goneCount)).toBeUndefined()
      expect(taskPageGitHubResumeCache.read('gone', 1)).toBeNull()
    }
  )

  it('ends a held read whose owner is removed and re-added, but keeps an unbound read', async () => {
    const store = setup()
    const owner = store.getState().githubSourceCollections
    const save = Promise.withResolvers<Repo>()
    mockApi.repos.update.mockReturnValueOnce(save.promise)
    const saving = store.getState().setIssueSourcePreference(repo.id, repo.path, 'origin', 'local')
    const reading = owner.readCurrent(store.getState().repos, () =>
      store.getState().fetchWorkItems(repo.id, repo.path, 20, '')
    )
    await flush()
    store.setState({ repos: [] })
    store.setState({ repos: [{ ...repo, issueSourcePreference: 'origin' }] })
    save.resolve({ ...repo, issueSourcePreference: 'origin' })
    await saving
    expect(await reading).toBeUndefined()
    expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
    expect(store.getState().workItemsCache).toEqual({})
    const unbound = await owner.readCurrent([undefined], () =>
      store.getState().fetchWorkItems('unregistered', '/unregistered', 20, '')
    )
    expect(unbound).toHaveLength(1)
  })

  it('follows superseding saves without spending reads, then reads once', async () => {
    const store = setup()
    const saves = [0, 1, 2].map(() => Promise.withResolvers<Repo>())
    for (const save of saves) {
      mockApi.repos.update.mockReturnValueOnce(save.promise)
    }
    mockApi.gh.listWorkItems.mockResolvedValue(envelope('fork'))
    const set = () =>
      store.getState().setIssueSourcePreference(repo.id, repo.path, 'origin', 'local')
    const pending = [set()]
    const reading = store
      .getState()
      .githubSourceCollections.readCurrent(store.getState().repos, () =>
        store.getState().fetchWorkItems(repo.id, repo.path, 20, '')
      )
    for (let superseding = 0; superseding < 2; superseding++) {
      await flush()
      pending.push(set())
    }
    for (const save of saves) {
      save.resolve({ ...repo, issueSourcePreference: 'origin' })
      await flush()
    }
    await Promise.all(pending)
    expect(await reading).toHaveLength(1)
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(1)
  })

  it('opens the clicked current-binding row over an older binding copy of the same issue', async () => {
    const store = setup()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      ...envelope('parent'),
      items: [{ ...row('parent'), title: 'Old title' }]
    })
    await store.getState().fetchWorkItems(repo.id, repo.path, 20, '')
    await store.getState().setIssueSourcePreference(repo.id, repo.path, 'upstream', 'local')
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      ...envelope('parent'),
      items: [{ ...row('parent'), title: 'Fresh title' }]
    })
    const [clicked] =
      (await store.getState().fetchWorkItems(repo.id, repo.path, 20, '', { force: true })) ?? []
    expect(
      findTaskPageDialogWorkItem(
        store.getState().workItemsCache,
        clicked,
        githubTaskBinding(store.getState().repos[0])
      )?.title
    ).toBe('Fresh title')
  })
})

describe('source mapping and estimate retirement', () => {
  it('keeps unregistered legacy reads usable without certifying another repository estimate', async () => {
    const store = setup()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({ ...envelope('parent'), items: [] })
    await store.getState().fetchWorkItems('unregistered-a', '/unregistered-a', 20, '')
    mockApi.gh.countWorkItems.mockResolvedValueOnce(40)
    expect(
      await store
        .getState()
        .countWorkItemsAcrossRepos([{ repoId: 'unregistered-b', path: '/unregistered-b' }], '', 20)
    ).toEqual({ totalCount: 40, totalPages: 2 })
  })

  it('joins an already running discovery without another list, retains known answers on opaque failure, and retires complete empty evidence', async () => {
    const store = setup()
    const held = Promise.withResolvers<ReturnType<typeof envelope>>()
    mockApi.gh.listWorkItems.mockReturnValueOnce(held.promise)
    mockApi.gh.countWorkItems.mockResolvedValue(60)
    const counting = store.getState().countWorkItemsAcrossRepos(args, '', 20)
    const list = store.getState().fetchWorkItems(repo.id, repo.path, 20, '')
    await flush()
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(1)
    held.resolve(envelope('parent'))
    await list
    expect(await counting).toEqual({ totalCount: 60, totalPages: 3 })
    const owner = store.getState().githubSourceCollections
    const key = owner.countKey([owner.capture(store.getState().repos[0]).scope], '', 20)
    mockApi.gh.countWorkItems.mockResolvedValue(0)
    expect(await store.getState().countWorkItemsAcrossRepos(args, '', 20)).toBeUndefined()
    expect(owner.count(key)?.totalCount).toBe(60)
    mockApi.gh.countWorkItems.mockRejectedValueOnce(new Error('offline'))
    expect(await store.getState().countWorkItemsAcrossRepos(args, '', 20)).toBeUndefined()
    expect(owner.count(key)?.totalCount).toBe(60)
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      ...envelope('parent'),
      items: [],
      errors: { issues: { type: 'unknown', message: 'partial' } }
    })
    await store.getState().fetchWorkItems(repo.id, repo.path, 20, '', { force: true })
    mockApi.gh.countWorkItems.mockResolvedValueOnce(20)
    expect(await store.getState().countWorkItemsAcrossRepos(args, '', 20)).toBeUndefined()
    expect(owner.count(key)?.totalCount).toBe(60)
    mockApi.gh.listWorkItems.mockResolvedValueOnce({ ...envelope('parent'), items: [] })
    await store.getState().fetchWorkItems(repo.id, repo.path, 20, '', { force: true })
    expect(owner.count(key)).toBeUndefined()
    expect(await store.getState().countWorkItemsAcrossRepos(args, '', 20)).toEqual({
      totalCount: 0,
      totalPages: 0
    })
  })

  it('retires every query and resume page when origin alone changes, and cannot revive a removed owner through a pending save', async () => {
    const store = setup()
    await store.getState().fetchWorkItems(repo.id, repo.path, 20, '')
    mockApi.gh.countWorkItems.mockResolvedValue(40)
    await store.getState().countWorkItemsAcrossRepos(args, '', 20)
    const owner = store.getState().githubSourceCollections
    const oldOwner = owner.context(repo)
    taskPageGitHubResumeCache.write('old-context', 2, [row('parent')], undefined, [oldOwner])
    const oldQuery = Promise.withResolvers<ReturnType<typeof envelope>>()
    mockApi.gh.listWorkItems.mockReturnValueOnce(oldQuery.promise)
    const old = store.getState().fetchWorkItems(repo.id, repo.path, 20, 'label:old')
    await flush()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      ...envelope('parent'),
      sources: {
        ...envelope('parent').sources,
        originCandidate: { owner: 'new-fork', repo: 'project' }
      }
    })
    await store.getState().fetchWorkItems(repo.id, repo.path, 20, 'label:new')
    oldQuery.resolve(envelope('parent'))
    expect(await old).toBeUndefined()
    expect(store.getState().getCachedWorkItems(repo.id, 20, '', repo.path)).toBeNull()
    expect(taskPageGitHubResumeCache.read('old-context', 2)).toBeNull()
    expect(owner.context(repo)).not.toBe(oldOwner)
    const save = Promise.withResolvers<Repo>()
    mockApi.repos.update.mockReturnValueOnce(save.promise)
    const saving = store.getState().setIssueSourcePreference(repo.id, repo.path, 'origin', 'local')
    const waiting = owner.awaitSave(store.getState().repos[0])
    const oldCatalog = owner.catalogSnapshot()
    store.setState({ repos: [] })
    const removed = await waiting
    expect(removed !== 'save-failed' && removed()).toBe(false)
    store.setState({ repos: [{ ...repo, issueSourcePreference: 'upstream' }] })
    const replacement = owner.context(store.getState().repos[0])
    save.resolve({ ...repo, issueSourcePreference: 'origin' })
    await saving
    expect(store.getState().repos[0].issueSourcePreference).toBe('upstream')
    expect(owner.context(store.getState().repos[0])).toBe(replacement)
    expect(
      owner.adopt({ ...repo, issueSourcePreference: 'origin' }, oldCatalog).issueSourcePreference
    ).toBe('upstream')
    expect(store.getState().getCachedWorkItems(repo.id, 20, '', repo.path)).toBeNull()
  })
})
