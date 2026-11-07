// @vitest-environment happy-dom
import { act, useRef } from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, renderHook, render, screen, fireEvent, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskPageGitHubIssueDialog } from './IssueDialog'
import { useTaskPageWorkItemsCacheSelection } from './use-task-page-work-items-cache-selection'
import { buildTaskPageRepoSourceState } from '../task-page-cache-selectors'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { createGitHubSlice } from '@/store/github/github'
import { createRepoUpdateActions } from '@/store/repos/repo-update'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
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
const mocks = vi.hoisted(() => ({ createIssue: vi.fn(), workItem: vi.fn(), updateRepo: vi.fn() }))
vi.mock('@/store/index', async () => {
  const { useStore } = await import('zustand')
  return {
    useAppStore: Object.assign(
      <T,>(selector: (state: AppState) => T) => useStore(holders.store!, selector),
      { getState: () => holders.store!.getState() }
    )
  }
})
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn()
}))
vi.mock('@/components/github/GitHubMarkdownComposer', () => ({
  GitHubMarkdownComposer: () => null
}))
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
    executionHostId: 'local',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '',
    addedAt: 1
  }
  store.setState({
    ...createGitHubSlice(store.setState, store.getState, store),
    ...createRepoUpdateActions(store.setState, store.getState),
    repos: [repo],
    projects: [],
    projectHostSetups: [],
    settings: createGlobalSettingsFixture(),
    fetchReposForAllHosts: vi.fn().mockResolvedValue(undefined)
  })
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
  return { ...rendered, store, repo, setter }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  mocks.createIssue.mockResolvedValue({ ok: true, number: 1, url: item(1).url })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: { createIssue: mocks.createIssue, workItem: mocks.workItem },
      repos: { update: mocks.updateRepo }
    }
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

describe('New Issue source-save dependency', () => {
  it('keeps the mounted New Issue selector and draft across a held source save', async () => {
    const { store, repo, result } = setup()
    const origin = { owner: 'fork', repo: 'project' }
    const upstream = { owner: 'parent', repo: 'project' }
    Object.assign(window.api.gh, {
      listWorkItems: vi.fn().mockResolvedValue({
        items: [],
        sources: {
          issues: upstream,
          prs: upstream,
          originCandidate: origin,
          upstreamCandidate: upstream
        }
      })
    })
    await act(async () => {
      await store.getState().fetchWorkItems(repo.id, repo.path, 20, '')
    })
    function Composer() {
      const repos = useStore(store, (s) => s.repos)
      const selected = useTaskPageWorkItemsCacheSelection(repos, 20, '')
      const fields = {
        ...result.current,
        selectedRepos: repos,
        newIssueTargetRepo: repos[0],
        githubSourceDisplayState: buildTaskPageRepoSourceState(
          repos,
          selected.sourceDisplayWorkItemsCacheEntries
        ),
        newIssueOpen: true,
        setIssueSourcePreference: store.getState().setIssueSourcePreference,
        submitShortcutLabel: 'Ctrl+Enter',
        newIssueRepoId: repo.id,
        setNewIssueRepoId: vi.fn(),
        newIssueRepoLabels: { data: [], loading: false, error: null },
        newIssueRepoAssignees: { data: [], loading: false, error: null }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these fields cover every IssueDialog input; later provider/composer stages add no fields read by this dialog.
      const model = fields as unknown as TaskPageComposerActionsModel
      return (
        <TooltipProvider>
          <TaskPageGitHubIssueDialog model={model} />
        </TooltipProvider>
      )
    }
    render(<Composer />)
    const dialog = within(screen.getByRole('dialog'))
    const picker = dialog.getByRole('group', { name: 'Issue source' })
    const title = dialog.getByDisplayValue('Created issue')
    const held = Promise.withResolvers<Repo>()
    mocks.updateRepo.mockReturnValueOnce(held.promise)
    await act(async () => {
      fireEvent.click(dialog.getByRole('button', { name: 'Origin' }))
      await Promise.resolve()
    })
    expect(dialog.getByRole('group', { name: 'Issue source' })).toBe(picker)
    expect(dialog.getByDisplayValue('Created issue')).toBe(title)
    expect(dialog.getByRole('button', { name: 'Origin' })).toHaveAttribute('aria-pressed', 'true')
    await act(async () => {
      held.resolve({ ...repo, issueSourcePreference: 'origin' })
      await held.promise
    })
  })
})
