// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'
import { mergeFetchedRepoCatalog } from '../repos/repo-catalog-merge'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { createRepoUpdateActions } from '../repos/repo-update'
import { useTaskPageWorkItemsCacheSelection } from '@/components/task-page/github/use-task-page-work-items-cache-selection'
import { buildTaskPageRepoSourceState } from '@/components/task-page/task-page-cache-selectors'
import {
  getTaskPageRepoCacheInput,
  getTaskPageRepoSourceContext
} from '@/components/task-page/task-page-source-context'
import { taskPageGitHubResumeCache } from '@/components/task-page/github/task-page-github-resume-cache'
import IssueSourceSelector from '@/components/github/IssueSourceSelector'
import { TooltipProvider } from '@/components/ui/tooltip'
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
function Picker() {
  const repos = useStore(holder.store!, (s) => s.repos)
  const { sourceDisplayWorkItemsCacheEntries } = useTaskPageWorkItemsCacheSelection(repos, 20, '')
  const state = buildTaskPageRepoSourceState(
    repos.map(getTaskPageRepoCacheInput),
    sourceDisplayWorkItemsCacheEntries
  )[0]
  return (
    <TooltipProvider>
      <IssueSourceSelector
        preference={repos[0].issueSourcePreference}
        origin={state.sources?.originCandidate ?? null}
        upstream={state.sources?.upstreamCandidate ?? null}
        onChange={(preference) => {
          void holder
            .store!.getState()
            .setIssueSourcePreference(repo.id, repo.path, preference, 'local')
        }}
      />
    </TooltipProvider>
  )
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
  it('keeps the same known selector mounted while the selected source list is held', async () => {
    const store = setup()
    await store.getState().fetchWorkItems(repo.id, repo.path, 20, '', {
      sourceContext: getTaskPageRepoSourceContext(repo, 'github')
    })
    render(<Picker />)
    const selector = screen.getByRole('group', { name: 'Issue source' })
    const held = Promise.withResolvers<ReturnType<typeof envelope>>()
    mockApi.gh.listWorkItems.mockReturnValue(held.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Origin' }))
    await act(flush)
    expect(screen.getByRole('group', { name: 'Issue source' })).toBe(selector)
    expect(screen.getByRole('button', { name: 'Origin' })).toHaveAttribute('aria-pressed', 'true')
    held.resolve(envelope('fork'))
  })

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
    const catalog = {
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
})

describe('source mapping and estimate retirement', () => {
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
    expect(await waiting).toBeUndefined()
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
