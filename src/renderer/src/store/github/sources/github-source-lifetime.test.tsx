// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from '../github-slice-test-harness'
import { createRepoUpdateActions } from '../../repos/repo-update'
import { taskPageGitHubResumeCache } from '@/components/task-page/github/task-page-github-resume-cache'
import type { AppState } from '../../types'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import type { Repo } from '../../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'

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
})

describe('source mapping and estimate retirement', () => {
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
