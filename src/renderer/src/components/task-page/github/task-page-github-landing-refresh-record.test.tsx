// @vitest-environment happy-dom
import { parseTaskQuery } from '../../../../../shared/task-query'
import { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'
import { useGitHubTaskItems, useGitHubTaskProjectTable } from '@/hooks/useGitHubTaskItems'
import { useWorkItemSourceState } from '@/components/new-workspace/use-work-item-source-state'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStore } from 'zustand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks
} from '@/store/slices/github-slice-test-harness'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubProjectTable } from '../../../../../shared/github/project-types'
import { getTaskPageRepoSourceContext } from '@/lib/task-repo-source-context'
import { runTaskPageGitHubLandingRefresh } from './task-page-github-landing-refresh-run'
import type { TaskPageGitHubLandingRefreshModel } from './task-page-github-landing-refresh-model'
import { resetTaskPageGitHubMutationRegistryForTests } from './task-page-github-work-item-mutation-registry'

const mocks = vi.hoisted(() => {
  const hoisted: { store: ReturnType<typeof createTestStore> | null } = { store: null }
  return hoisted
})
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (s: AppState) => unknown) => useStore(mocks.store!, selector),
    {
      getState: () => mocks.store!.getState(),
      subscribe: (listener: (s: AppState) => void) => mocks.store!.subscribe(listener)
    }
  )
}))
vi.mock('@/lib/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemByOwnerRepoForSource: vi.fn(async () => null)
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1
}
const row: GitHubWorkItem = {
  id: 'issue:42',
  repoId: 'repo',
  type: 'issue',
  number: 42,
  title: 'Visible',
  state: 'open',
  labels: [],
  assignees: [],
  url: 'https://github.com/acme/widgets/issues/42',
  author: null,
  updatedAt: '2026-10-31T12:00:02Z'
}
const sources = {
  issues: { owner: 'acme', repo: 'widgets' },
  prs: null,
  originCandidate: null,
  upstreamCandidate: null
}
const source = getTaskPageRepoSourceContext(repo, 'github')
type Pages = (GitHubWorkItem[] | null)[]
/** The same issue on a local Project board, as the board's own fetch stored it. */
const board: GitHubProjectTable = {
  project: {
    id: 'p',
    owner: 'acme',
    ownerType: 'organization',
    number: 1,
    title: 'Board',
    url: ''
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
  rows: [
    {
      id: 'r',
      position: 0,
      itemType: 'ISSUE',
      updatedAt: '2026-10-31T12:00:02Z',
      fieldValuesByFieldId: {},
      content: {
        title: row.title,
        body: null,
        url: row.url,
        repository: 'acme/widgets',
        number: 42,
        state: 'OPEN',
        stateReason: null,
        isDraft: null,
        parentIssue: null,
        issueType: null,
        labels: [],
        assignees: []
      }
    }
  ],
  totalCount: 1,
  parentFieldDropped: false
}
const LOCAL = { kind: 'local' } as const
const NO_ROWS: GitHubWorkItem[] = []
let root: Root, node: HTMLDivElement
let mutationModel: ReturnType<typeof useTaskPageGitHubWorkItemMutation>
let picker: ReturnType<typeof useWorkItemSourceState>
let setPages: (next: Pages | ((previous: Pages) => Pages)) => void
const pagesRef: { current: Pages } = { current: [] }
/** Tasks, the new-workspace picker and a Project board each project their own stored rows. */
function Harness() {
  const [pages, set] = useState<Pages>([])
  setPages = set
  pagesRef.current = pages
  mutationModel = useTaskPageGitHubWorkItemMutation({
    queryKey: 'landing',
    query: parseTaskQuery(''),
    viewerLogin: 'alice',
    patchWorkItem: mocks.store!.getState().patchWorkItem
  })
  picker = useWorkItemSourceState(false, '')
  const tasks = useGitHubTaskItems(pages[0] ?? NO_ROWS)
  const project = useGitHubTaskProjectTable(board, LOCAL)
  return (
    <output>
      {tasks.map((item) => item.state).join()}|{picker.githubItems.map((i) => i.state).join()}|
      {project?.rows[0].content.state?.toLowerCase()}
    </output>
  )
}
const ref = <T,>(current: T) => ({ current })
const noop = () => {}
/** A non-forced landing refresh with the Tasks page's own setters, refs and store actions. */
async function landingRefresh() {
  const state = mocks.store!.getState()
  const model: TaskPageGitHubLandingRefreshModel = {
    fetchWorkItemsAcrossRepos: state.fetchWorkItemsAcrossRepos,
    getCachedWorkItems: state.getCachedWorkItems,
    fetchWorkItemsNextPage: state.fetchWorkItemsNextPage,
    countWorkItemsAcrossRepos: state.countWorkItemsAcrossRepos,
    workItemsInvalidationNonce: 0,
    selectedRepos: [repo],
    taskSource: 'github',
    taskResumeApplied: true,
    githubMode: 'items',
    appliedTaskSearch: '',
    taskRefreshNonce: 0,
    lastFetchedNonceRef: ref(0),
    lastFetchedInvalidationNonceRef: ref(0),
    paginationGenerationRef: ref(0),
    landingGitHubRefreshKeysRef: ref<ReadonlySet<string>>(new Set()),
    githubPerRepoPageLimit: 20,
    githubPageSize: 20,
    githubResumeContextKey: 'landing',
    githubResumeConsumedRef: ref(true),
    githubResumeContextRef: ref('landing'),
    pendingGithubScrollRestoreRef: ref<number | null>(null),
    countedTotalPagesRef: ref<number | null>(null),
    hardRefreshEpochRef: ref(0),
    currentPageRef: ref(0),
    pagesRef,
    setPages,
    retryingSourceKeys: new Set<string>(),
    githubWorkItemMutationQueryKey: 'landing',
    setTasksLoading: noop,
    setTasksRefreshing: noop,
    setTasksFiltering: noop,
    setTasksError: noop,
    setFailedCount: noop,
    setGithubUnavailable: noop,
    setCurrentPage: noop,
    setPaginationLoading: noop,
    setLoadingTargetPage: noop,
    setCountedTotalPages: noop,
    setProvenPageLimit: noop,
    setRetryingSourceKeys: noop
  }
  await act(async () => {
    runTaskPageGitHubLandingRefresh(model)
    for (let i = 0; i < 8; i++) {
      await Promise.resolve()
    }
  })
}
const stored = () =>
  Object.values(mocks.store!.getState().workItemsCache).flatMap((entry) => entry.data ?? [])

describe('a tracked Tasks edit through the landing refresh', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    resetTaskPageGitHubMutationRegistryForTests()
    mocks.store = createTestStore()
    mocks.store.setState({ repos: [repo], recordFeatureInteraction: vi.fn() })
    mockApi.gh.listWorkItems.mockResolvedValue({ items: [row], sources })
    node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    await act(async () => root.render(<Harness />))
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    node.remove()
  })

  it.each(['provisional', 'accepted'])(
    'stores no pending close in the cache or pages, and a failure leaves every copy as it was (%s owner)',
    async (owner) => {
      await landingRefresh()
      const cache = mocks.store!.getState().githubTaskCache
      if (owner === 'accepted') {
        await cache.readCanonical(row, cache.capture(repo, source)!, async () => row)
      }
      const before = { stored: stored(), pages: pagesRef.current }
      expect(before.pages[0]?.map((item) => item.state)).toEqual(['open'])
      let finish!: (value: { ok: false; error: string }) => void
      let result!: Promise<'confirmed' | 'rolled_back' | 'stale'>
      await act(async () => {
        result = mutationModel.run({
          item: pagesRef.current[0]![0],
          intent: { type: 'setState', state: 'closed' },
          sourceContext: source,
          mutate: () => new Promise((resolve) => (finish = resolve)),
          errorToast: 'Unable to update'
        })
        picker.setGithubItems(stored())
      })
      // The landing refresh reads the fresh cache and reapplies pending Tasks edits mid-flight.
      await landingRefresh()
      expect(stored().map((item) => item.state)).toEqual(['open'])
      expect(pagesRef.current[0]?.map((item) => item.state)).toEqual(['open'])
      expect(node.textContent).toBe('closed|closed|closed')
      await act(async () => {
        finish({ ok: false, error: 'denied' })
        expect(await result).toBe('rolled_back')
      })
      expect(stored()).toEqual(before.stored)
      expect(pagesRef.current).toEqual(before.pages)
      expect(node.textContent).toBe('open|open|open')
    }
  )
})
