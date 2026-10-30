import { parseTaskQuery } from '../../../shared/task-query'
import {
  repo,
  source,
  key,
  projectKey,
  user,
  seed,
  oldDetails,
  returned,
  projectRow,
  table,
  resume
} from './github-task-refresh-data.test-fixture'
// @vitest-environment happy-dom
import {
  context,
  useItem,
  store,
  container,
  taskMutation,
  harnessSetPages,
  direct,
  update,
  list,
  issueType,
  fixture,
  mount,
  click,
  draft
} from './github-task-refresh.test-fixture'

import * as translations from '@/i18n/i18n'

import React, { act } from 'react'
import { useStore } from 'zustand'
import GitHubItemDialog from '@/components/github-item-dialog/open-dialog/github-item-dialog'
import { getTaskPageRepoSourceContext } from '@/components/task-page/task-page-source-context'
import { PRActionsPanel } from '@/components/pull-request-page/actions/panel'
import { findTaskPageDialogWorkItem } from '@/components/task-page/task-page-cache-selectors'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  workItemDetailsCache,
  invalidateWorkItemDetailsCacheForKey
} from '@/components/github-item-dialog/load-item-details/work-item-details-cache'

import { expect, it, vi } from 'vitest'

import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'

import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import { workItemsCacheKey, projectViewCacheKey } from '@/store/github/cache-identity'

import { taskPageGitHubResumeCache } from '@/components/task-page/github/task-page-github-resume-cache'

import { buildProjectWorkItem } from '@/components/github-project/project-work-item'
import { buildTaskSourceContextFromRepo } from '../../../shared/task-source-context'

import { runTaskPageGitHubQuietRefresh } from '@/components/task-page/github/task-page-github-quiet-refresh-run'
import type { TaskPageGitHubQuietRefreshPreludeModel } from '@/components/task-page/github/use-task-page-github-quiet-refresh'

import { runTaskPageGitHubLandingRefresh } from '@/components/task-page/github/task-page-github-landing-refresh-run'
import type { TaskPageGitHubSearchPaginationModel } from '@/components/task-page/github/use-task-page-github-search-pagination'

const actual = await vi.importActual<typeof translations>('@/i18n/i18n')

it('clicks the real header/direct reader/settler and publishes accepted data to URL aliases, page-N, resume, drawer and two Project views', async () => {
  const { twin } = fixture()
  const foreignSource = { ...source, projectId: 'different-registered-account' }
  const foreignKey = workItemsCacheKey(repo.id, 30, '', getTaskSourceCacheScope(foreignSource))
  const remoteProjectKey = projectViewCacheKey(
    'organization',
    'o',
    1,
    'view',
    undefined,
    'runtime:other'
  )
  const foreign = { data: [seed], fetchedAt: 11 },
    remoteProject = { data: table, fetchedAt: 12 }
  store.setState((state) => ({
    workItemsCache: { ...state.workItemsCache, [foreignKey]: foreign },
    projectViewCache: { ...state.projectViewCache, [remoteProjectKey]: remoteProject }
  }))
  context.openedItem = buildProjectWorkItem(
    { ...projectRow, content: { ...projectRow.content, assignees: [user('alice')] } },
    repo
  )!
  context.openedSource = buildTaskSourceContextFromRepo({
    provider: 'github',
    projectId: repo.id,
    repo
  })!
  expect(context.openedItem.assignees).toBeUndefined()
  list.mockResolvedValueOnce({ items: [{ ...seed, id: 'issue:5' }] })
  await store.getState().fetchWorkItems(repo.id, repo.path, 30, 'legacy')
  const legacyKey = workItemsCacheKey(repo.id, 30, 'legacy')
  list.mockClear()
  const cachedAt = 1_700_000_000_000
  taskPageGitHubResumeCache.write(resume, 2, context.pages[2]!, cachedAt)
  const before = taskPageGitHubResumeCache.read(resume, 2, cachedAt)!.cachedAt
  await mount()
  expect(direct).toHaveBeenCalledTimes(1)
  await click('Add Bob')
  expect(store.getState().workItemsCache[key].data?.[0].assignees).toBeUndefined() // no automatic delta-derived publication
  const beforeRefresh = direct.mock.calls.length
  direct.mockResolvedValue(returned)
  await click()
  expect(direct).toHaveBeenCalledTimes(beforeRefresh + 1)
  expect(list).not.toHaveBeenCalled()
  expect(direct.mock.calls.at(-1)?.[0]).toMatchObject({
    repoId: repo.id,
    sourceContext: context.openedSource,
    ownerRepo: { owner: 'o', repo: 'r', host: 'github.com' }
  })
  expect(container.querySelector('h1')?.textContent).toContain('Accepted title')
  expect(container.querySelector('[data-assignees]')?.textContent).toBe('alice,bob')
  expect(container.querySelector('[data-body]')?.textContent).toBe('Accepted body')
  expect(context.pages[2]?.[0]).toMatchObject({
    id: 'issue:5',
    title: 'Accepted title',
    assignees: returned.item.assignees
  })
  expect(context.pages[2]?.[1]).toBe(twin)
  expect(store.getState().workItemsCache[key].data?.[0]).toMatchObject({
    id: 'issue:5',
    title: 'Accepted title',
    repoHostId: 'local'
  })
  expect(store.getState().workItemsCache[legacyKey].data?.[0]).toMatchObject({
    id: 'issue:5',
    title: 'Accepted title'
  })
  expect(store.getState().githubTaskDrawerWorkItem).toMatchObject({
    id: seed.id,
    title: 'Accepted title'
  })
  expect(taskPageGitHubResumeCache.read(resume, 2, cachedAt)?.cachedAt).toBe(before)
  expect(taskPageGitHubResumeCache.read(resume, 2, cachedAt)?.items[0].title).toBe('Accepted title')
  for (const entry of Object.values(store.getState().projectViewCache).filter(
    (entry) => entry !== remoteProject
  )) {
    expect(entry).toMatchObject({
      data: {
        rows: [
          {
            id: 'project-row',
            content: {
              title: 'Accepted title',
              body: 'Accepted body',
              assignees: returned.item.assignees
            }
          }
        ]
      }
    })
  }
  expect(store.getState().workItemsCache[foreignKey]).toBe(foreign)
  expect(store.getState().projectViewCache[remoteProjectKey]).toBe(remoteProject)
  expect(store.getState().projectViewCache[projectKey].data?.rows[0].fieldValuesByFieldId).toBe(
    projectRow.fieldValuesByFieldId
  )
  await click('Start workspace from issue')
  expect(useItem).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: context.openedItem.id, title: 'Accepted title' })
  )
})

it.each(['immediate', 'tasks', 'body', 'project'])(
  'keeps the finite intent alive across a real %s failure/rollback and retries only after its final callback',
  async (writer) => {
    await mount()
    const first = Promise.withResolvers<GitHubWorkItemDetails | null>(),
      write = Promise.withResolvers<{ ok: boolean; error?: string }>()
    direct.mockReturnValueOnce(first.promise).mockResolvedValue(returned)
    await click()
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh task"]')?.disabled
    ).toBe(true)
    update.mockReturnValueOnce(write.promise)
    let writing: Promise<unknown> | undefined
    if (writer === 'immediate') {
      await click('Add Bob')
    }
    if (writer === 'tasks') {
      await act(async () => {
        writing = taskMutation.run({
          item: seed,
          sourceContext: source,
          intent: { type: 'toggleAssignee', user: user('bob') },
          mutate: update,
          errorToast: 'Rejected'
        })
      })
    }
    if (writer === 'body') {
      await draft('Body draft', 'Write body')
      await click('Save body')
    }
    if (writer === 'project') {
      await act(async () => {
        writing = store
          .getState()
          .patchProjectIssueOrPr(projectKey, 'project-row', { title: 'Write title' })
      })
    }
    await act(async () => first.resolve(returned))
    expect(direct).toHaveBeenCalledTimes(2)
    await act(async () => {
      write.resolve({ ok: false, error: 'Rejected edit' })
      await writing
    })
    expect(direct).toHaveBeenCalledTimes(3)
    expect(container.querySelector('[data-assignees]')?.textContent).toBe('alice,bob')
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh task"]')?.disabled
    ).toBe(false)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  }
)

it('waits for a pre-open Project Issue Type whole-row rollback, then accepts true empty membership; failure retains visible content and permits retry', async () => {
  const pending = Promise.withResolvers<{ ok: boolean; error: { type: string; message: string } }>()
  issueType.mockReturnValueOnce(pending.promise)
  const writing = store.getState().patchProjectRowIssueType(projectKey, 'project-row', {
    id: 'bug',
    name: 'Bug',
    color: null,
    description: null
  })
  await mount()
  direct.mockResolvedValue({ ...returned, item: { ...returned.item, assignees: [] } })
  await click()
  expect(direct).toHaveBeenCalledTimes(1)
  await act(async () => {
    pending.resolve({ ok: false, error: { type: 'unknown', message: 'Rejected type' } })
    await writing
  })
  expect(direct).toHaveBeenCalledTimes(2)
  expect(store.getState().projectViewCache[projectKey].data?.rows[0].content).toMatchObject({
    title: 'Accepted title',
    assignees: []
  })
  direct.mockResolvedValueOnce({
    ...returned,
    item: { ...returned.item, url: 'https://github.com/o/r/issues/6' }
  })
  await click()
  expect(container.querySelector('h1')?.textContent).toContain('Accepted title')
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
  direct.mockResolvedValue(returned)
  await click()
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('reconciles a real aggregate held leaf at landing final commit against a newer ordinary edit, then allows a later ordinary read', async () => {
  await mount()
  const otherRepo = { ...repo, id: 'other', path: '/other' },
    gate = Promise.withResolvers<unknown>()
  store.setState({ repos: [repo, otherRepo] })
  list.mockImplementation((args: { repoId: string }) =>
    args.repoId === 'other'
      ? gate.promise
      : Promise.resolve({
          items: [{ ...seed, id: 'issue:5', title: 'Old list' }],
          sources: { issues: null, prs: null }
        })
  )
  const pagesRef = { current: context.pages },
    nonce = { current: 0 }
  const setPages = (
    change: typeof context.pages | ((p: typeof context.pages) => typeof context.pages)
  ) => {
    harnessSetPages((current) => {
      const next = typeof change === 'function' ? change(current) : change
      pagesRef.current = next
      return next
    })
  }
  const noop = () => {}
  const model = {
    ...store.getState(),
    selectedRepos: [repo, otherRepo],
    taskSource: 'github',
    taskResumeApplied: true,
    githubMode: 'items',
    appliedTaskSearch: '',
    appliedTaskQuery: parseTaskQuery('is:open'),
    githubViewerLogin: 'alice',
    selectedReposKey: '',
    taskRefreshNonce: 1,
    lastFetchedNonceRef: { current: 0 },
    lastFetchedInvalidationNonceRef: { current: 0 },
    paginationGenerationRef: nonce,
    landingGitHubRefreshKeysRef: { current: new Set() },
    githubPerRepoPageLimit: 30,
    githubPageSize: 30,
    githubResumeContextKey: resume,
    setPages,
    pagesRef,
    currentPageRef: { current: 0 },
    githubResumeConsumedRef: { current: true },
    githubResumeContextRef: { current: resume },
    pendingGithubScrollRestoreRef: { current: 0 },
    countedTotalPagesRef: { current: null },
    hardRefreshEpochRef: { current: 0 },
    retryingSourceKeys: new Set(),
    setRetryingSourceKeys: noop,
    githubWorkItemMutationQueryKey: 'q',
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
    setProvenPageLimit: noop
  }
  let cleanup: (() => void) | undefined
  await act(async () => {
    cleanup = runTaskPageGitHubLandingRefresh(model as TaskPageGitHubSearchPaginationModel)
  }) // SAFETY: supplied fields cover this production runner's complete path.
  direct.mockResolvedValue(returned)
  await click()
  await act(async () =>
    harnessSetPages((current) =>
      current.map(
        (page) =>
          page?.map((row) => (row.url === seed.url ? { ...row, title: 'Newer edit' } : row)) ?? null
      )
    )
  )
  pagesRef.current = context.pages
  await act(async () => gate.resolve({ items: [], sources: { issues: null, prs: null } }))
  expect(
    context.pages.flatMap((page) => page ?? []).find((row) => row.url === seed.url)?.title
  ).toBe('Newer edit')
  cleanup?.()
  list.mockResolvedValue({
    items: [{ ...seed, title: 'Later ordinary' }],
    sources: { issues: null, prs: null }
  })
  await act(async () => {
    await store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, '', { force: true, sourceContext: source })
  })
  expect(store.getState().workItemsCache[key].data?.[0].title).toBe('Later ordinary')
  await act(async () =>
    taskMutation.run({
      item: seed,
      sourceContext: source,
      intent: { type: 'toggleAssignee', user: user('bob') },
      mutate: update,
      errorToast: 'Rejected'
    })
  )
  const authority = Promise.withResolvers<unknown>(),
    visible = Promise.withResolvers<unknown>()
  list.mockReturnValueOnce(authority.promise).mockReturnValueOnce(visible.promise)
  const owner = {},
    currentPageRef = { current: 0 }
  const quietCleanup = runTaskPageGitHubQuietRefresh({
    ...model,
    selectedRepos: [repo],
    pages: context.pages,
    currentPage: 0,
    currentPageRef,
    quietRefreshNonce: 1,
    setQuietRefreshNonce: noop,
    quietRevalidateMountedRef: { current: true },
    quietRevalidateOwnerRef: { current: owner },
    quietRevalidateScopeRef: { current: { queryKey: 'q', generation: 1 } }
  } as TaskPageGitHubQuietRefreshPreludeModel) // SAFETY: complete runner state with actual slice fetch actions.
  currentPageRef.current = 2
  await act(async () => authority.resolve({ items: [seed], sources: { issues: null, prs: null } }))
  direct.mockResolvedValue({ ...returned, item: { ...returned.item, title: 'Second accepted' } })
  await click()
  await act(async () =>
    harnessSetPages((current) =>
      current.map(
        (page) =>
          page?.map((row) =>
            row.url === seed.url ? { ...row, title: 'After second acceptance' } : row
          ) ?? null
      )
    )
  )
  pagesRef.current = context.pages
  await act(async () => visible.resolve({ items: [seed], sources: { issues: null, prs: null } }))
  expect(context.pages[0]?.find((row) => row.url === seed.url)?.title).toBe(
    'After second acceptance'
  )
  quietCleanup?.()
  const { useTaskPageGitHubLandingRefresh } =
    await import('@/components/task-page/github/use-task-page-github-landing-refresh')
  const { VisibleReaders } = await import('./github-task-refresh-visible-readers.test-fixture')
  const cancelledLeaf = Promise.withResolvers<unknown>()
  list.mockImplementation((args: { query?: string }) =>
    args.query === 'is:open assignee:cora'
      ? cancelledLeaf.promise
      : Promise.resolve({
          items: [{ ...seed, title: 'Current landing Dora', assignees: [user('dora')] }],
          sources: { issues: { owner: 'o', repo: 'r' }, prs: null }
        })
  )
  let landingPages = context.pages
  function LandingOwner({ search, mutationKey }: { search: string; mutationKey: string }) {
    const [pages, setPages] = React.useState<(GitHubWorkItem[] | null)[]>([])
    const live = React.useRef(pages)
    React.useLayoutEffect(() => {
      landingPages = pages
      live.current = pages
    }, [pages])
    useTaskPageGitHubLandingRefresh({
      ...model,
      selectedRepos: [repo],
      appliedTaskSearch: search,
      appliedTaskQuery: parseTaskQuery(search),
      githubWorkItemMutationQueryKey: mutationKey,
      currentPageRef,
      pagesRef: live,
      setPages,
      githubResumeContextKey: 'cancellation-control',
      taskRefreshNonce: 3
    } as TaskPageGitHubSearchPaginationModel)
    // SAFETY: reuse the complete real landing model with this owner's actual React pages/setter.
    return (
      <TooltipProvider>
        <VisibleReaders
          pages={[null, null, pages[0] ?? null]}
          mutation={taskMutation}
          queryKey={mutationKey}
          query={search}
          viewerLogin="alice"
          kind="issues"
        />
      </TooltipProvider>
    )
  }
  await act(async () =>
    context.root.render(<LandingOwner search="is:open assignee:cora" mutationKey="landing-old" />)
  )
  await act(async () =>
    context.root.render(<LandingOwner search="is:open assignee:dora" mutationKey="landing-new" />)
  )
  expect(landingPages[0]?.[0].title).toBe('Current landing Dora')
  await act(async () =>
    cancelledLeaf.resolve({
      items: [{ ...seed, title: 'Cancelled landing Cora', assignees: [user('cora')] }],
      sources: { issues: { owner: 'o', repo: 'r' }, prs: null }
    })
  )
  console.info(
    'R5-BOUNDARY-LANDING-CANCEL',
    JSON.stringify({
      pages: landingPages,
      visible: [...container.querySelectorAll('[data-tasks] h3')].map((n) => n.textContent)
    })
  )
  expect(landingPages[0]?.[0].title).toBe('Current landing Dora')
  expect(container.querySelector('[data-tasks] h3')?.textContent).toBe('Current landing Dora')
})

it.each(['rollback', 'null', 'error'] as const)(
  'keeps optimistic labels across ordinary detail completion and %s, then accepts changed state/labels without a parent seed callback',
  async (outcome) => {
    await mount(true)
    await click()
    const canonical = [...workItemDetailsCache.entries()].find(([, entry]) => entry.route)!
    const ordinary = Promise.withResolvers<GitHubWorkItemDetails | null>()
    const write = Promise.withResolvers<{ ok: boolean; error?: string }>()
    direct.mockReturnValueOnce(ordinary.promise)
    await act(async () => invalidateWorkItemDetailsCacheForKey(canonical[0]))
    update.mockReturnValueOnce(write.promise)
    await click('Add bug')
    const labels = () => container.querySelector('[data-labels]')?.textContent
    expect(labels()).toBe('bug')
    await act(async () =>
      ordinary.resolve({ ...oldDetails, item: { ...oldDetails.item, labels: [] } })
    )
    expect(labels()).toBe('bug')
    expect(
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Add bug')
        ?.disabled
    ).toBe(true)
    if (outcome === 'error') {
      direct.mockRejectedValueOnce(new Error('Read failed'))
    } else if (outcome === 'null') {
      direct.mockResolvedValueOnce(null)
    }
    await act(async () =>
      write.resolve(outcome === 'rollback' ? { ok: false, error: 'Rejected' } : { ok: true })
    )
    expect(labels()).toBe(outcome === 'rollback' ? '' : 'bug')
    expect(context.openedItem).toBe(seed)
    await draft('Body draft', 'Keep body')
    await draft('Comment draft', 'Keep comment')
    direct.mockResolvedValue({
      ...returned,
      item: { ...returned.item, state: 'closed', labels: ['accepted'] }
    })
    await click()
    expect(labels()).toBe('accepted')
    direct.mockResolvedValue({ ...returned, item: { ...returned.item, state: 'open', labels: [] } })
    await click()
    expect(labels()).toBe('')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Body draft"]')?.value).toBe(
      'Keep body'
    )
    expect(container.querySelector<HTMLInputElement>('[aria-label="Comment draft"]')?.value).toBe(
      'Keep comment'
    )
    const late = Promise.withResolvers<GitHubWorkItemDetails | null>()
    direct.mockReturnValueOnce(late.promise)
    await click()
    context.openedItem = { ...seed, url: 'https://github.com/other/r/issues/5', labels: ['other'] }
    direct.mockResolvedValue({ ...oldDetails, item: context.openedItem })
    await mount(true)
    await act(async () => late.resolve(returned))
    expect(labels()).toBe('other')
  }
)

it('keeps a production-prefetched foreign legacy PR unchanged through real local close rollback/success and merge callbacks', async () => {
  const local: GitHubWorkItem = {
    ...seed,
    id: 'pr:5',
    type: 'pr',
    url: 'https://github.com/o/r/pull/5',
    mergeable: 'MERGEABLE'
  }
  const foreign = {
    ...local,
    url: 'https://github.com/upstream/r/pull/5',
    repoHostId: 'ssh:builder' as const
  }
  const sshRepo = {
    ...repo,
    path: '/remote/repo',
    connectionId: 'builder',
    executionHostId: 'ssh:builder' as const
  }
  store.setState({ repos: [repo, sshRepo], workItemsCache: {} })
  const sources = {
    issues: { owner: 'o', repo: 'r' },
    prs: { owner: 'o', repo: 'r' },
    originCandidate: { owner: 'o', repo: 'r' },
    upstreamCandidate: null
  }
  list.mockResolvedValueOnce({ items: [foreign], sources })
  await act(async () => {
    store.getState().prefetchWorkItems(repo.id, sshRepo.path, 30, 'is:pr is:open')
    await store.getState().fetchWorkItems(repo.id, sshRepo.path, 30, 'is:pr is:open')
  })
  const foreignKey = Object.keys(store.getState().workItemsCache)[0]
  const foreignEntry = store.getState().workItemsCache[foreignKey]
  expect(foreignKey).toContain('ssh:builder::')
  list.mockResolvedValueOnce({ items: [local], sources })
  await act(async () => {
    await store.getState().fetchWorkItems(repo.id, repo.path, 30, '', { sourceContext: source })
  })
  direct.mockReturnValueOnce(Promise.withResolvers<GitHubWorkItemDetails | null>().promise)
  const foreignSource = getTaskPageRepoSourceContext(sshRepo, 'github')
  function PanelAndDrawer() {
    const [state, setState] = React.useState<GitHubWorkItem['state']>('open')
    const row = useStore(store, (s) => findTaskPageDialogWorkItem(s.workItemsCache, foreign))
    return (
      <TooltipProvider>
        <PRActionsPanel
          item={local}
          repoPath={repo.path}
          repoId={repo.id}
          sourceContext={source}
          projectOrigin={undefined}
          localState={state}
          onStateChange={setState}
          onMutated={() => {}}
        />
        <section data-foreign-drawer>
          <GitHubItemDialog
            workItem={row ?? foreign}
            repoPath={sshRepo.path}
            sourceContext={foreignSource}
            onUse={() => {}}
            onClose={() => {}}
          />
        </section>
      </TooltipProvider>
    )
  }
  await act(async () => context.root.render(<PanelAndDrawer />))
  const assertForeign = () => {
    expect(store.getState().workItemsCache[foreignKey]).toBe(foreignEntry)
    expect(container.querySelector('[data-foreign-drawer]')?.textContent).toContain('Open')
  }
  const write = Promise.withResolvers<{ ok: boolean; error?: string }>()
  update.mockReturnValueOnce(write.promise)
  await click('Close pull request')
  expect(store.getState().workItemsCache[key].data?.[0].state).toBe('closed')
  assertForeign()
  await act(async () => write.resolve({ ok: false, error: 'Rejected close' }))
  expect(store.getState().workItemsCache[key].data?.[0].state).toBe('open')
  assertForeign()
  update.mockResolvedValue({ ok: true })
  await click('Close pull request')
  expect(store.getState().workItemsCache[key].data?.[0].state).toBe('closed')
  assertForeign()
  await click('Reopen PR')
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  const merge = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (node) => node.textContent === 'Squash and merge'
  )!
  expect(merge).toBeTruthy()
  await act(async () => merge.click())
  expect(store.getState().workItemsCache[key].data?.[0].state).toBe('merged')
  assertForeign()
})

it('translates the real Refresh header tooltip and one failed DIRECT alert while preserving pending controls and retry', async () => {
  const translate = vi.spyOn(translations, 'translate').mockImplementation(actual.translate)
  const language = actual.i18n.language
  const prior = actual.i18n.hasResourceBundle('fr', 'translation')
    ? structuredClone(actual.i18n.getResourceBundle('fr', 'translation'))
    : undefined
  actual.i18n.addResourceBundle(
    'fr',
    'translation',
    {
      auto: {
        components: {
          GitHubItemDialog: {
            refreshTask: 'Actualiser la tâche',
            refreshTaskFailed: 'Impossible d’actualiser cette tâche. Réessayez.'
          }
        }
      }
    },
    true,
    true
  )
  try {
    await actual.i18n.changeLanguage('fr')
    await mount(true)
    await draft('Body draft', 'Keep body')
    await draft('Comment draft', 'Keep comment')
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Actualiser la tâche"]')!
    expect(button).toBeTruthy()
    expect(button.classList.contains('size-7')).toBe(true)
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    })
    await vi.waitFor(() => {
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Actualiser la tâche')
    })
    const pending = Promise.withResolvers<GitHubWorkItemDetails | null>()
    direct.mockReturnValueOnce(pending.promise)
    const beforeCalls = direct.mock.calls.length
    await click('Actualiser la tâche')
    expect(direct).toHaveBeenCalledTimes(beforeCalls + 1)
    expect(button.disabled).toBe(true)
    expect(button.classList.contains('size-7')).toBe(true)
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
    await act(async () => pending.reject(new Error('Provider rejected')))
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Impossible d’actualiser cette tâche. Réessayez.'
    )
    expect(button.disabled).toBe(false)
    expect(container.querySelector<HTMLInputElement>('[aria-label="Body draft"]')?.value).toBe(
      'Keep body'
    )
    expect(container.querySelector<HTMLInputElement>('[aria-label="Comment draft"]')?.value).toBe(
      'Keep comment'
    )
    direct.mockResolvedValueOnce(returned)
    await click('Actualiser la tâche')
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
    expect(button.disabled).toBe(false)
  } finally {
    await actual.i18n.changeLanguage(language)
    actual.i18n.removeResourceBundle('fr', 'translation')
    if (prior) {
      actual.i18n.addResourceBundle('fr', 'translation', prior, true, true)
    }
    translate.mockRestore()
  }
})
