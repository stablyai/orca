import { createTaskRefreshStore } from './github-task-refresh-store.test-fixture'

import {
  createTaskRefreshApi,
  repo,
  source,
  projectKey,
  seed,
  oldDetails
} from './github-task-refresh-data.test-fixture'

// @vitest-environment happy-dom
import type * as I18nModule from '@/i18n/i18n'

import React, { act, useLayoutEffect, useCallback, useRef, useState } from 'react'

import { createRoot, type Root } from 'react-dom/client'

import { useStore, type StoreApi } from 'zustand'

import { afterEach, beforeEach, expect, vi } from 'vitest'

import type { AppState } from '@/store/types'

import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

import type { GitHubProjectTable, GitHubProjectRow } from '../../../shared/github/project-types'

import GitHubItemDialog from '@/components/github-item-dialog/open-dialog/github-item-dialog'

import { TaskPageGitHubIssueDialog } from '@/components/task-page/task-page-github-issue-dialog'

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

import { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'
import { useTaskPageGitHubMutationState } from '@/components/task-page/github/use-task-page-github-mutation-state'
import type { ListComposition } from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'

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
  const prepared = createTaskRefreshStore(n)
  store = prepared.store
  pages = prepared.pages
  return { others: prepared.others, twin: prepared.twin }
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
  const model: Parameters<typeof TaskPageGitHubIssueDialog>[0]['model'] = {
    dialogWorkItem: openedItem,
    dialogRepoPath: repo.path,
    dialogSourceContext: openedSource,
    dialogInitialTab: undefined,
    selectedRepos: store.getState().repos,
    appliedTaskQuery: parseTaskQuery(query),
    githubWorkItemMutationQueryKey: queryKey,
    githubViewerLogin: viewerLogin,
    handleDialogReviewRequestsChange: undefined,
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
        <TaskPageGitHubIssueDialog model={model} />
      )}
    </TooltipProvider>
  ) // SAFETY: this fixture deliberately renders only the issue branch with its production accepted callback.
}
type HarnessProps = { standalone?: boolean; outputs?: OutputRenderer; query?: string }
export function Harness(props: HarnessProps) {
  const [localPages, setPages] = useState(context.pages)
  useStore(store, (state) => state.repos)
  const mutation = useTaskPageGitHubWorkItemMutation({
    queryKey: 'q',
    query: parseTaskQuery(props.query ?? 'is:open'),
    viewerLogin: 'alice',
    patchWorkItem: store.getState().patchWorkItem
  })
  return <HarnessView {...props} localPages={localPages} setPages={setPages} mutation={mutation} />
}
let deferPageUpdates = false
let deferredPageUpdates: React.SetStateAction<(GitHubWorkItem[] | null)[]>[] = []
let commitPages: React.Dispatch<React.SetStateAction<(GitHubWorkItem[] | null)[]>>
export function ProductionHarness(props: HarnessProps) {
  const selectedRepos = useStore(store, (state) => state.repos)
  const [localPages, setLocalPages] = useState(context.pages)
  useLayoutEffect(() => {
    commitPages = setLocalPages
  }, [setLocalPages])
  const setPages = useCallback<typeof setLocalPages>((change) => {
    if (deferPageUpdates) {
      deferredPageUpdates.push(change)
    } else {
      setLocalPages(change)
    }
  }, [])
  const pagesRef = useRef(localPages)
  useLayoutEffect(() => {
    pagesRef.current = localPages
  }, [localPages])
  const [viewer, setViewer] = useState<string | null>(null)
  const [, setQuiet] = useState(0)
  // SAFETY: the actual mutation owner reads only this declared slice; no lifecycle is mocked.
  const input = {
    selectedRepos,
    taskSource: 'github' as const,
    githubMode: 'items' as const,
    appliedTaskSearch: props.query ?? 'is:open',
    activeTaskPreset: null,
    setQuietRefreshNonce: setQuiet,
    githubViewerLogin: viewer,
    setGitHubViewerLogin: setViewer,
    pages: localPages,
    pagesRef,
    setPages,
    perRepoSourceState: [],
    patchTaskPageWorkItemRows: (
      item: GitHubWorkItem,
      patch: Partial<GitHubWorkItem>,
      matches?: (row: GitHubWorkItem) => boolean,
      listComposition?: readonly ListComposition[]
    ) =>
      setPages((current) =>
        patchTaskPageGitHubWorkItemPages(current, item, patch, matches, listComposition)
      )
  }
  const owner = useTaskPageGitHubMutationState(input)
  return (
    <HarnessView
      {...props}
      localPages={localPages}
      setPages={setPages}
      mutation={owner.githubWorkItemMutation}
      queryKey={owner.githubWorkItemMutationQueryKey}
      viewerLogin={viewer}
    />
  )
}
export function holdPageUpdates() {
  deferPageUpdates = true
}
export function flushPageUpdates() {
  deferPageUpdates = false
  const queued = deferredPageUpdates
  deferredPageUpdates = []
  commitPages((current) =>
    queued.reduce((rows, update) => (typeof update === 'function' ? update(rows) : update), current)
  )
}

export function resetPageUpdates() {
  deferPageUpdates = false
  deferredPageUpdates = []
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
