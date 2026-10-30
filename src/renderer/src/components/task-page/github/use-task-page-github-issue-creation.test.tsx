// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createUIStore } from '@/store/slices/ui-slice-test-harness'
import { useTaskPageGitHubDetail } from '@/components/task-page/github/use-task-page-github-detail'
import { useTaskPageGitHubIssueCreation } from '@/components/task-page/github/use-task-page-github-issue-creation'
import { useTaskPageWorkspaceActions } from '@/components/task-page/use-task-page-workspace-actions'
import type { GitHubListRestoreWrite } from './task-page-github-list-scroll-restore'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { AppState } from '@/store/types'
import type { StoreApi } from 'zustand/vanilla'

const holders = vi.hoisted((): { store: StoreApi<AppState> | null } => ({ store: null }))
const mocks = vi.hoisted(() => ({ createIssue: vi.fn(), workItem: vi.fn() }))
vi.mock('@/store/index', async () => {
  const { useStore } = await import('zustand')
  return {
    useAppStore: Object.assign(
      <T,>(selector: (state: AppState) => T) => useStore(holders.store!, selector),
      { getState: () => holders.store!.getState() }
    )
  }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))

function item(number: number): GitHubWorkItem {
  return {
    id: `issue:${number}`,
    type: 'issue',
    number,
    title: `Issue ${number}`,
    state: 'open',
    url: `https://github.com/o/r/issues/${number}`,
    labels: [],
    assignees: [],
    updatedAt: '2026-10-28T00:00:00Z',
    author: null,
    repoId: 'repo-1'
  }
}
function setup() {
  const store = createUIStore()
  store.setState({ workItemsCache: {} })
  holders.store = store
  const repo: Repo = {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '',
    addedAt: 1
  }
  const setter = vi.fn()
  const rendered = renderHook(() => {
    const detail = useTaskPageGitHubDetail({
      pageData: useStore(store, (s) => s.taskPageData),
      openTaskPage: store.getState().openTaskPage,
      repos: [],
      selectedRepos: [],
      primaryRepo: repo,
      setGithubMode: setter,
      gitlabDialogItem: null,
      setGitlabDialogItem: setter,
      appliedTaskSearch: '',
      githubPerRepoPageLimit: 36,
      githubResumeContextKey: 'local',
      pages: [],
      currentPage: 0,
      currentPageRef: useRef(0),
      githubListScrollRef: useRef<HTMLDivElement | null>(null),
      githubListScrollTopRef: useRef(0),
      pendingGithubScrollRestoreRef: useRef<number | null>(null),
      githubListRestoreWriteRef: useRef<GitHubListRestoreWrite | null>(null),
      taskListPositionRef: useRef<AppState['taskListPosition']>(null)
    })
    const workspace = useTaskPageWorkspaceActions({
      ...detail,
      openModal: store.getState().openModal
    })
    return useTaskPageGitHubIssueCreation({
      ...workspace,
      setNewIssueOpen: setter,
      newIssueTitle: 'Created issue',
      setNewIssueTitle: setter,
      newIssueBody: 'Body',
      setNewIssueBody: setter,
      newIssueLabels: [],
      setNewIssueLabels: setter,
      newIssueAssignees: [],
      setNewIssueAssignees: setter,
      newIssueSubmitting: false,
      setNewIssueSubmitting: setter,
      setTaskRefreshNonce: setter,
      setNewIssueDraft: setter,
      clearNewIssueDraft: setter,
      newIssueTargetRepo: repo,
      newIssueSourceContext: null,
      newIssueRuntimeTarget: null
    })
  })
  return { ...rendered, store }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  mocks.createIssue.mockResolvedValue({ ok: true, number: 1, url: item(1).url })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gh: { createIssue: mocks.createIssue, workItem: mocks.workItem } }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  holders.store = null
})

async function createIssuePendingDetail() {
  const pending = Promise.withResolvers<GitHubWorkItem>()
  mocks.workItem.mockReturnValue(pending.promise)
  const rendered = setup()
  await act(async () => {
    await rendered.result.current.handleCreateNewIssue()
  })
  const resolveDetail = async (detail: GitHubWorkItem): Promise<void> => {
    await act(async () => {
      pending.resolve(detail)
      await pending.promise
    })
  }
  return { ...rendered, resolveDetail }
}

describe('created issue hydration ownership', () => {
  it('hydrates the created issue when it remains selected', async () => {
    const { store, resolveDetail } = await createIssuePendingDetail()
    expect(store.getState().githubTaskDrawerWorkItem?.number).toBe(1)
    await resolveDetail({ ...item(1), title: 'Hydrated one' })
    expect(store.getState().githubTaskDrawerWorkItem?.title).toBe('Hydrated one')
  })
  it('preserves a newer selection of another issue', async () => {
    const { result, store, resolveDetail } = await createIssuePendingDetail()
    const next = item(2)
    act(() => {
      result.current.openGitHubDetailPage(next)
    })
    await resolveDetail(item(1))
    expect(store.getState().githubTaskDrawerWorkItem).toBe(next)
    expect(store.getState().taskPageData.openGitHubWorkItem).toBe(next)
  })
  it('keeps the list open after navigating back from the created issue', async () => {
    const { store, resolveDetail } = await createIssuePendingDetail()
    act(() => {
      store.getState().openTaskPage({ taskSource: 'github' })
    })
    await resolveDetail(item(1))
    expect(store.getState().githubTaskDrawerWorkItem).toBeNull()
  })
  it('keeps the drawer closed after using the issue in the workspace composer', async () => {
    const { result, store, resolveDetail } = await createIssuePendingDetail()
    const stub = store.getState().githubTaskDrawerWorkItem
    if (!stub) {
      throw new Error('Expected the created issue to be open')
    }
    act(() => {
      result.current.setDialogWorkItem(null)
      result.current.handleUseWorkItem(stub)
    })
    await resolveDetail(item(1))
    expect(store.getState().activeModal).toBe('new-workspace-composer')
    expect(store.getState().githubTaskDrawerWorkItem).toBeNull()
  })
})
