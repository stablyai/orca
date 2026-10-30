import {
  Harness,
  ProductionHarness,
  holdPageUpdates,
  flushPageUpdates,
  resetPageUpdates
} from './github-task-refresh-harness.test-fixture'

import { createRepoUpdateActions } from '@/store/repos/repo-update'

import {
  createTaskRefreshApi,
  repo,
  source,
  key,
  projectKey,
  seed,
  oldDetails,
  table
} from './github-task-refresh-data.test-fixture'

// @vitest-environment happy-dom
import type * as I18nModule from '@/i18n/i18n'

import React, { act, useLayoutEffect } from 'react'

import { createRoot, type Root } from 'react-dom/client'

import { createStore, useStore, type StoreApi } from 'zustand'

import { afterEach, beforeEach, expect, vi } from 'vitest'

import type { AppState } from '@/store/types'

import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

import type { GitHubProjectTable, GitHubProjectRow } from '../../../shared/github/project-types'

import { createGitHubSlice } from '@/store/slices/github'

import GitHubItemDialog from '@/components/github-item-dialog/open-dialog/github-item-dialog'

import { TaskPageContent } from '@/components/task-page/Content'

import type { TaskPageComposerActionsModel } from '@/components/task-page/use-task-page-composer-actions'

import { TooltipProvider } from '@/components/ui/tooltip'

import { parseTaskQuery } from '../../../shared/task-query'

import { patchTaskPageGitHubWorkItemPages } from '@/components/task-page/github/task-page-github-work-item-mutation-pages'

import {
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import { taskPageGitHubResumeCache } from '@/components/task-page/github/task-page-github-resume-cache'

import { workItemDetailsCache } from '@/components/github-item-dialog/load-item-details/work-item-details-cache'

import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

import type { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'

import {
  createRuntimeStatusSlice,
  clearRuntimeEnvironmentConnectionGenerationsForTests
} from '@/store/slices/runtime-status'

let store: StoreApi<AppState>
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (s: AppState) => unknown) => useStore(store, select), {
    getState: () => store.getState(),
    setState: (...args: Parameters<StoreApi<AppState>['setState']>) => store.setState(...args),
    subscribe: (listener: (s: AppState, previous: AppState) => void) => store.subscribe(listener)
  })
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))
vi.mock('@/components/PullRequestPage', () => ({ default: () => null }))
vi.mock('@/components/github-project/ProjectViewWrapper', () => ({ default: () => null }))
vi.mock('@/components/github-project/useProjectViewTable', () => ({
  useProjectViewTable: () => {
    const table = useStore(store, (s) => s.projectViewCache[projectKey]?.data)
    return {
      table,
      visibleTable: table,
      currentCacheKey: projectKey,
      activeProject: table?.project,
      views: [],
      sourceTarget: { kind: 'local' },
      loading: false
    }
  }
}))
vi.mock('@/lib/repo-slug-index', () => ({
  useRepoSlugIndex: () => ({
    ready: true,
    lookupSlug: () => [repo],
    lookupSlugMatches: () => ({ origin: [repo], upstream: [] })
  })
}))
vi.mock('@/components/github-project/ProjectViewToolbar', () => ({
  ProjectViewToolbar: () => null
}))
vi.mock('@/components/github-project/ProjectViewStates', () => ({
  ProjectViewTabStrip: () => null
}))
vi.mock('@/components/github-project/ProjectViewList', () => ({
  default: (p: { table: GitHubProjectTable; onOpenDialog: (r: GitHubProjectRow) => void }) => (
    <button onClick={() => p.onOpenDialog(p.table.rows[0])}>Open Project task</button>
  )
}))
vi.mock('@/components/github-project/ProjectBoard', () => ({ default: () => null }))
vi.mock('@/components/github-project/ProjectRoadmap', () => ({ default: () => null }))
vi.mock('@/components/github-project/ProjectItemSlugDialog', () => ({ default: () => null }))
vi.mock('@/components/github-project/ProjectMissingRepoDialog', () => ({
  ProjectMissingRepoDialog: () => null
}))
vi.mock('@/components/task-page/github/List', () => ({ TaskPageGitHubList: () => null }))
vi.mock('@/components/task-page/gitlab/TodoList', () => ({ TaskPageGitLabTodoList: () => null }))
vi.mock('@/components/task-page/gitlab/ItemList', () => ({ TaskPageGitLabItemList: () => null }))
vi.mock('@/components/task-page/jira/Content', () => ({ TaskPageJiraContent: () => null }))
vi.mock('@/components/github-item-dialog/open-dialog/github-item-dialog-pr-tabs', () => ({
  GitHubItemDialogPRTabs: () => null
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/store/selectors', () => ({ useAllWorktrees: () => [] }))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18nModule>()),
  translate: (_: string, fallback: string) => fallback
}))
vi.mock('@/hooks/useIssueMetadata', async () => ({
  ...(await import('@/hooks/useImmediateMutation')),
  useRepoLabels: () => ({ data: [] }),
  useRepoAssignees: () => ({ data: [] })
}))
vi.mock('@/hooks/useGitHubSlugMetadata', () => ({
  useRepoLabelsBySlug: () => ({ data: [] }),
  useRepoAssigneesBySlug: () => ({ data: [] })
}))
vi.mock('@/components/github/github-duplicate-issue-candidates', () => ({
  useGitHubDuplicateIssueCandidates: () => []
}))
vi.mock(
  '@/components/github-item-dialog/edit-item-fields/gh-edit-section-top-columns',
  async () => ({
    GHEditSectionTopColumns: (await import('./github-task-refresh-renderers.test-fixture'))
      .GHEditSectionTopColumns
  })
)
vi.mock('@/components/github-item-dialog/discuss-item/conversation-tab-description', async () => ({
  ConversationTabDescription: (await import('./github-task-refresh-renderers.test-fixture'))
    .ConversationTabDescription
}))
vi.mock('@/components/github-item-dialog/discuss-item/conversation-tab-activity', async () => ({
  ConversationTabActivity: (await import('./github-task-refresh-renderers.test-fixture'))
    .ConversationTabActivity
}))
vi.mock('@/components/github/GitHubMarkdownComposer', async () => ({
  GitHubMarkdownComposer: (await import('./github-task-refresh-renderers.test-fixture'))
    .GitHubMarkdownComposer
}))

let harnessSetPages: React.Dispatch<React.SetStateAction<(GitHubWorkItem[] | null)[]>>
let taskMutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>

let openedItem = seed,
  openedSource = source
let root: Root,
  container: HTMLDivElement,
  pages: (GitHubWorkItem[] | null)[],
  useItem = vi.fn()
const direct = vi.fn(),
  update = vi.fn(),
  list = vi.fn(),
  issueType = vi.fn(),
  projectRead = vi.fn(),
  postComment = vi.fn()
function fixture(n = 1) {
  const others = Array.from({ length: n - 1 }, (_, i) => ({
    ...seed,
    id: `issue:${i + 10}`,
    number: i + 10,
    url: `https://github.com/o/r/issues/${i + 10}`
  }))
  const twin = {
    ...seed,
    id: 'issue:5',
    url: 'https://github.com/upstream/r/issues/5',
    title: 'Twin'
  }
  store = createStore<AppState>()(
    (...args) =>
      ({
        ...createGitHubSlice(...args),
        ...createRuntimeStatusSlice(...args),
        ...createRepoUpdateActions(args[0], args[1]),
        repos: [repo],
        settings: null,
        endpointProjects: [],
        endpointProjectHostSetups: [],
        projects: [],
        projectHostSetups: [],
        runtimeStatusByEnvironmentId: new Map(),
        taskPageData: { openGitHubWorkItem: seed, openGitHubSourceContext: source },
        githubTaskDrawerWorkItem: seed,
        recordFeatureInteraction: vi.fn(),
        recordFeatureInteractionOnce: vi.fn(),
        workItemsCache: {
          [key]: { data: [{ ...seed, id: 'issue:5' }, twin, ...others], fetchedAt: 10 }
        },
        projectViewCache: {
          [projectKey]: { data: table, fetchedAt: 20 },
          [projectKey.replace('view', 'view2')]: { data: table, fetchedAt: 30 }
        }
      }) as AppState
  ) // SAFETY: only selected Task/Project fields and real GitHub slice actions are exercised.
  pages = [null, null, [{ ...seed, id: 'issue:5' }, twin, ...others]]
  return { others, twin }
}
export type OutputRenderer = (
  pages: (GitHubWorkItem[] | null)[],
  mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>,
  queryKey: string,
  viewerLogin: string | null
) => React.ReactNode
export function HarnessView({
  standalone = false,
  outputs,
  query = 'is:open',
  localPages,
  setPages,
  mutation,
  queryKey = 'q',
  viewerLogin = 'alice'
}: {
  standalone?: boolean
  outputs?: OutputRenderer
  query?: string
  queryKey?: string
  viewerLogin?: string | null
  localPages: (GitHubWorkItem[] | null)[]
  setPages: React.Dispatch<React.SetStateAction<(GitHubWorkItem[] | null)[]>>
  mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>
}) {
  useLayoutEffect(() => {
    taskMutation = mutation
    pages = localPages
    harnessSetPages = setPages
  }, [mutation, localPages, setPages])
  const model = {
    taskSource: 'github',
    dialogWorkItem: openedItem,
    dialogRepoPath: repo.path,
    dialogSourceContext: openedSource,
    dialogInitialTab: undefined,
    selectedRepos: store.getState().repos,
    appliedTaskQuery: parseTaskQuery(query),
    githubWorkItemMutationQueryKey: queryKey,
    githubViewerLogin: viewerLogin,
    setDialogWorkItem: vi.fn(),
    handleUseWorkItem: useItem,
    closeTaskDetailPage: vi.fn(),
    patchTaskPageWorkItemRows: (
      item: GitHubWorkItem,
      patch: Partial<GitHubWorkItem>,
      matches: (row: GitHubWorkItem) => boolean
    ) => setPages((current) => patchTaskPageGitHubWorkItemPages(current, item, patch, matches))
  }
  return (
    <TooltipProvider>
      {outputs?.(localPages, mutation, queryKey, viewerLogin)}
      {standalone ? (
        <GitHubItemDialog
          workItem={openedItem}
          repoPath={repo.path}
          sourceContext={openedSource}
          onUse={useItem}
          onClose={() => {}}
        />
      ) : (
        <TaskPageContent model={model as TaskPageComposerActionsModel} />
      )}
    </TooltipProvider>
  ) // SAFETY: this fixture deliberately renders only the issue branch with its production accepted callback.
}
async function mount(
  standalone = false,
  outputs?: OutputRenderer,
  query?: string,
  production = false
) {
  await act(async () => {
    const Component = production ? ProductionHarness : Harness
    root.render(<Component standalone={standalone} outputs={outputs} query={query} />)
  })
}
async function click(label = 'Refresh task') {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label || b.textContent === label
  )
  expect(button, label).toBeTruthy()
  await act(async () => {
    button!.click()
  })
}
async function draft(label: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
beforeEach(() => {
  resetPageUpdates()
  openedItem = seed
  openedSource = source
  clearRuntimeCompatibilityCacheForTests()
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  vi.clearAllMocks()
  workItemDetailsCache.clear()
  resetTaskPageGitHubMutationRegistryForTests()
  setTaskPageGitHubMutationQueryKey('q')
  fixture()
  Object.assign(window, {
    api: createTaskRefreshApi({ direct, update, list, issueType, projectRead, postComment })
  })
  direct.mockResolvedValue(oldDetails)
  update.mockResolvedValue({ ok: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  taskPageGitHubResumeCache.clear()
  workItemDetailsCache.clear()
})

export {
  useItem,
  store,
  container,
  taskMutation,
  harnessSetPages,
  direct,
  update,
  list,
  issueType,
  projectRead,
  postComment,
  fixture,
  mount,
  click,
  draft
}
export const context = {
  holdPageUpdates,
  flushPageUpdates,
  get pages() {
    return pages
  },
  set pages(value: typeof pages) {
    pages = value
  },
  get root() {
    return root
  },
  set root(value: typeof root) {
    root = value
  },
  get openedItem() {
    return openedItem
  },
  set openedItem(value: typeof openedItem) {
    openedItem = value
  },
  get openedSource() {
    return openedSource
  },
  set openedSource(value: typeof openedSource) {
    openedSource = value
  }
}

export { fieldsRenders } from './github-task-refresh-renderers.test-fixture'

export { confirmListForTest } from './github-task-refresh-data.test-fixture'
