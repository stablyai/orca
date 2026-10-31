import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import {
  confirmListForTest,
  context,
  store,
  fieldsRenders,
  useItem,
  container,
  taskMutation,
  direct,
  update,
  list,
  projectRead,
  postComment,
  mount,
  click,
  draft
} from './github-task-refresh.test-fixture'

import { parseTaskQuery } from '../../../shared/task-query'

import { createTaskPageGitHubMembershipProjection } from '@/components/task-page/github/task-page-github-work-item-mutation-composition'

import { captureGitHubTaskObservation } from './github-task-observation'

import { githubTaskSourceKey } from './github-task-target'

import {
  repo,
  source,
  key,
  projectKey,
  user,
  seed,
  oldDetails,
  returned,
  table,
  request
} from './github-task-refresh-data.test-fixture'

// @vitest-environment happy-dom

import type * as ProjectViewModule from '@/components/github-project/ProjectViewWrapper'

import React, { act } from 'react'

import { createRoot } from 'react-dom/client'

import { expect, it, vi } from 'vitest'

import type { Repo } from '../../../shared/repo-types'

import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'

import type { GitHubProjectTable } from '../../../shared/github/project-types'

import { TooltipProvider } from '@/components/ui/tooltip'

import { getTaskPageRepoSourceContext } from '@/components/task-page/task-page-source-context'

import { getTaskSourceCacheScope } from '../../../shared/task-source-context'

import { workItemsCacheKey } from '@/store/github/cache-identity'

import {
  getConfirmedListSnapshot,
  getListEntry,
  getTaskPageGitHubMembershipBases
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import {
  workItemDetailsCache,
  touchWorkItemDetailsCache
} from '@/components/github-item-dialog/load-item-details/work-item-details-cache'

import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'

import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

import { GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY } from '../../../shared/task-source-runtime-capabilities'

import { taskPageGitHubMutationItemId } from '@/components/task-page/github/task-page-github-work-item-mutation-keys'

import { useSmartWorkspaceGithubSearch } from '@/components/new-workspace/use-smart-workspace-github-search'

import { useTaskPageGitHubSearchPagination } from '@/components/task-page/github/use-task-page-github-search-pagination'

it.each([false, true])(
  'preserves old paired opens and only the declared canonical button; paired fork edits keep their inherited route (old=%s)',
  async (old) => {
    const runtimeRepo: Repo = {
      ...repo,
      executionHostId: 'runtime:server',
      issueSourcePreference: 'upstream'
    }
    context.openedItem = { ...seed, repoHostId: 'runtime:server' }
    context.openedSource = getTaskPageRepoSourceContext(runtimeRepo, 'github')!
    const runtimeKey = workItemsCacheKey(
      repo.id,
      30,
      '',
      getTaskSourceCacheScope(context.openedSource)
    )
    const upstream = {
      ...context.openedItem,
      url: 'https://github.com/upstream/r/issues/5',
      title: 'Upstream'
    }
    store.setState({
      repos: [runtimeRepo],
      workItemsCache: { [runtimeKey]: { data: [context.openedItem, upstream], fetchedAt: 10 } }
    })
    let canonicalResponse: Promise<GitHubWorkItemDetails | null> | GitHubWorkItemDetails = returned
    const call = vi.fn(
      async ({ method, params }: { method: string; params?: { ownerRepo?: unknown } }) => {
        if (method === 'status.get') {
          const status = createCompatibleRuntimeStatusResponse()
          if (old && status.ok) {
            status.result.capabilities = status.result.capabilities?.filter(
              (cap) => cap !== GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY
            )
          }
          return status
        }
        return {
          id: 'rpc',
          ok: true,
          result:
            method === 'github.workItemDetails'
              ? params?.ownerRepo
                ? await canonicalResponse
                : { ...oldDetails, item: upstream }
              : { ok: true },
          _meta: { runtimeId: 'remote-runtime' }
        }
      }
    )
    Object.assign(window.api, { runtimeEnvironments: { call } })
    await mount()
    expect(container.querySelector('h1')?.textContent).toContain(seed.title)
    expect(JSON.parse(container.querySelector('[data-editor-item]')!.textContent!)).toMatchObject({
      title: seed.title,
      url: seed.url,
      id: seed.id
    })
    expect(
      JSON.parse(container.querySelector('[data-conversation-item]')!.textContent!)
    ).toMatchObject(upstream)
    await click('Start workspace from issue')
    expect(useItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: seed.title, url: seed.url })
    )
    await click('Copy GitHub link')
    expect(window.api.ui.writeClipboardText).toHaveBeenLastCalledWith(seed.url)
    await click('Open on GitHub')
    expect(window.api.shell.openUrl).toHaveBeenLastCalledWith(seed.url)
    expect(
      call.mock.calls.find(([args]) => args.method === 'github.workItemDetails')?.[0].params
    ).not.toHaveProperty('ownerRepo')
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Refresh task"]')!
    expect(button.disabled).toBe(old)
    if (old) {
      expect(
        call.mock.calls.filter(([args]) => args.method === 'github.workItemDetails')
      ).toHaveLength(1)
      return
    }
    await click('Add Bob')
    expect(
      call.mock.calls.find(([args]) => args.method === 'github.updateIssue')?.[0].params
    ).not.toHaveProperty('ownerRepo')
    const pending = Promise.withResolvers<GitHubWorkItemDetails | null>()
    canonicalResponse = pending.promise
    await draft('Comment draft', 'Fork draft')
    await click()
    expect(container.querySelector('h1')?.textContent).toContain(seed.title)
    expect(
      JSON.parse(container.querySelector('[data-conversation-item]')!.textContent!)
    ).toMatchObject(upstream)
    await act(async () => pending.resolve({ ...returned, item: upstream }))
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.querySelector('h1')?.textContent).toContain(seed.title)
    canonicalResponse = returned
    await click()
    expect(container.querySelector('h1')?.textContent).toContain('Accepted title')
    await click('Start workspace from issue')
    expect(useItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Accepted title', id: seed.id, url: seed.url })
    )
    expect(container.querySelector<HTMLInputElement>('[aria-label="Comment draft"]')?.value).toBe(
      'Fork draft'
    )
    const canonicalKey = [...workItemDetailsCache.entries()].find(([, entry]) => entry.route)![0]
    const { invalidateWorkItemDetailsCacheForKey } =
      await import('@/components/github-item-dialog/load-item-details/work-item-details-cache')
    await act(async () => invalidateWorkItemDetailsCacheForKey(canonicalKey))
    expect(
      call.mock.calls.findLast(([args]) => args.method === 'github.workItemDetails')?.[0].params
    ).toHaveProperty('ownerRepo')
    expect(store.getState().workItemsCache[runtimeKey].data?.map((row) => row.title)).toEqual([
      'Accepted title',
      'Upstream'
    ])
    const last = call.mock.calls.findLast(([args]) => args.method === 'github.workItemDetails')?.[0]
    expect(last?.params).toMatchObject({ ownerRepo: { owner: 'o', repo: 'r', host: 'github.com' } })
    expect(list).not.toHaveBeenCalled()
    const obsolete = Promise.withResolvers<GitHubWorkItemDetails | null>()
    canonicalResponse = obsolete.promise
    await click()
    context.openedItem = {
      ...context.openedItem,
      url: 'https://github.com/other/r/issues/5',
      title: 'Other fork seed',
      labels: ['other']
    }
    await mount()
    await act(async () => obsolete.resolve(returned))
    expect(container.querySelector('h1')?.textContent).toContain('Other fork seed')
    expect(container.querySelector('[data-labels]')?.textContent).toBe('other')
  }
)

it('keeps drafts during acceptance, ignores unrelated store/host updates, and disposes an old-account intent before accepting it', async () => {
  await mount()
  const before = fieldsRenders
  await act(async () =>
    store.setState({
      settings: {
        ...createGlobalSettingsFixture(),
        ...store.getState().settings,
        activeRuntimeEnvironmentId: 'unrelated'
      }
    })
  ) // SAFETY: this field is the only setting read by the inactive routing branch.
  expect(fieldsRenders).toBe(before)
  await act(async () => {
    const status = createCompatibleRuntimeStatusResponse('another-runtime')
    if (status.ok) {
      store
        .getState()
        .setRuntimeEnvironmentStatus('other-host', { checkedAt: 1, status: status.result })
    }
  })
  expect(fieldsRenders).toBe(before)
  await draft('Body draft', 'Unsaved body')
  await draft('Comment draft', 'Unsaved comment')
  direct.mockResolvedValue(returned)
  await click()
  expect(container.querySelector<HTMLInputElement>('[aria-label="Body draft"]')?.value).toBe(
    'Unsaved body'
  )
  expect(container.querySelector<HTMLInputElement>('[aria-label="Comment draft"]')?.value).toBe(
    'Unsaved comment'
  )
  postComment.mockResolvedValue({
    ok: true,
    comment: {
      id: 10,
      author: 'alice',
      authorAvatarUrl: '',
      body: 'New optimistic comment',
      createdAt: '',
      url: seed.url
    }
  })
  await click('Send comment')
  await click()
  expect(container.querySelector('[data-comments]')?.textContent).toContain(
    'New optimistic comment'
  )
  const obsolete = Promise.withResolvers<GitHubWorkItemDetails | null>()
  direct.mockReturnValueOnce(obsolete.promise)
  await click()
  const bobDetails = { ...returned, item: { ...returned.item, title: 'Bob account' } }
  direct.mockResolvedValue(bobDetails)
  await act(async () =>
    store.setState({ repos: [{ ...repo, ghAccount: { host: 'github.com', user: 'bob' } }] })
  )
  expect(fieldsRenders).toBeGreaterThan(before)
  await act(async () => obsolete.resolve(returned))
  expect(container.querySelector('h1')?.textContent).toContain('Bob account')
  expect(container.querySelector('[role="alert"]')).toBeNull()
  await click()
  expect(container.querySelector('h1')?.textContent).toContain('Bob account')
})

const { default: Project } = await vi.importActual<typeof ProjectViewModule>(
  '@/components/github-project/ProjectViewWrapper'
)

it('updates the real retained Project selection, survives detail eviction, and reconciles its old store writer without changing Project metadata', async () => {
  await act(async () =>
    context.root.render(
      <TooltipProvider>
        <Project selectedRepoIds={new Set([repo.id])} sourceHostId="local" />
      </TooltipProvider>
    )
  )
  await click('Open Project task')
  const pending = Promise.withResolvers<{ ok: true; data: GitHubProjectTable }>()
  projectRead.mockReturnValueOnce(pending.promise)
  const reading = store
    .getState()
    .fetchProjectViewTable({ kind: 'local' }, request, { force: true })
  direct.mockResolvedValue(returned)
  await click()
  store
    .getState()
    .patchProjectRowContent(projectKey, 'project-row', { title: 'Newer Project edit' })
  await act(async () => {
    pending.resolve({ ok: true, data: table })
    await reading
  })
  expect(store.getState().projectViewCache[projectKey].data?.rows[0]).toMatchObject({
    position: 7,
    updatedAt: 'project-time',
    content: { title: 'Newer Project edit', assignees: returned.item.assignees }
  })
  workItemDetailsCache.clear()
  await act(async () =>
    context.root.render(
      <TooltipProvider>
        <Project selectedRepoIds={new Set([repo.id])} sourceHostId="local" />
      </TooltipProvider>
    )
  )
  expect(container.querySelector('h1')?.textContent).toContain('Accepted title')
})

it('retires only captured contradictions through actual Tasks settlement and preserves equal/newer masks without a retry loop', async () => {
  await mount()
  await act(async () => {
    await taskMutation.run({
      item: seed,
      sourceContext: source,
      intent: { type: 'setState', state: 'closed' },
      mutate: update,
      errorToast: 'Rejected'
    })
  })
  expect(getTaskPageGitHubMembershipBases().size).toBeGreaterThan(0)
  const scope = getTaskSourceCacheScope(source),
    id = taskPageGitHubMutationItemId(seed)
  confirmListForTest(
    scope,
    repo.id,
    id,
    'assignees',
    [user('old')],
    captureGitHubTaskObservation(repo, source)
  )
  const observation = captureGitHubTaskObservation(repo, source)
  const address = {
    sourceScope: scope,
    repoId: repo.id,
    itemId: id,
    family: 'assignees' as const,
    observation
  }
  const capturedClaim = getListEntry(address)!.protection
  const held = Promise.withResolvers<GitHubWorkItemDetails | null>()
  direct.mockReturnValueOnce(held.promise)
  await click()
  list.mockResolvedValueOnce({
    items: [{ ...seed, assignees: [user('provider')] }],
    sources: { issues: { owner: 'o', repo: 'r' }, prs: null }
  })
  await act(async () => {
    await store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, '', { sourceContext: source, force: true })
  })
  expect(getListEntry(address)!.protection).toBe(capturedClaim)
  await act(async () => held.resolve(returned))
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
  direct.mockResolvedValue(returned)
  expect(
    createTaskPageGitHubMembershipProjection({
      query: parseTaskQuery('is:open'),
      queryKey: 'q',
      viewerLogin: 'alice'
    })(seed, githubTaskSourceKey(source), captureGitHubTaskObservation(repo, source)).hide
  ).toBe(false)
  expect(
    getConfirmedListSnapshot(
      scope,
      repo.id,
      id,
      'assignees',
      captureGitHubTaskObservation(repo, source)
    )
  ).toBeUndefined()
  confirmListForTest(
    scope,
    repo.id,
    id,
    'assignees',
    returned.item.assignees!,
    captureGitHubTaskObservation(repo, source)
  )
  const pending = Promise.withResolvers<GitHubWorkItemDetails | null>()
  direct.mockReturnValueOnce(pending.promise)
  await click()
  confirmListForTest(
    scope,
    repo.id,
    id,
    'assignees',
    returned.item.assignees!,
    captureGitHubTaskObservation(repo, source)
  )
  const newer = getConfirmedListSnapshot(
    scope,
    repo.id,
    id,
    'assignees',
    captureGitHubTaskObservation(repo, source)
  )
  await act(async () => pending.resolve(returned))
  expect(
    getConfirmedListSnapshot(
      scope,
      repo.id,
      id,
      'assignees',
      captureGitHubTaskObservation(repo, source)
    )
  ).toBe(newer)
  const contradiction = Promise.withResolvers<GitHubWorkItemDetails | null>()
  direct.mockReturnValueOnce(contradiction.promise)
  await click()
  confirmListForTest(
    scope,
    repo.id,
    id,
    'assignees',
    [user('new owner')],
    captureGitHubTaskObservation(repo, source)
  )
  const calls = direct.mock.calls.length
  await act(async () => contradiction.resolve(returned))
  expect(direct).toHaveBeenCalledTimes(calls)
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
  expect(
    getConfirmedListSnapshot(
      scope,
      repo.id,
      id,
      'assignees',
      captureGitHubTaskObservation(repo, source)
    )?.[0].login
  ).toBe('new owner')
})

it('keeps page-N navigation and a shared workspace raw callback through acceptance and a later edit', async () => {
  await mount()
  const gate = Promise.withResolvers<unknown>()
  list.mockReturnValue(gate.promise)
  let destination = -1,
    loading = true,
    paginationLoading = false,
    sharedItems: readonly GitHubWorkItem[] = []
  const pagesRef = { current: context.pages },
    currentPageRef = { current: 0 },
    noop = () => {}
  const foundation: Parameters<typeof useSmartWorkspaceGithubSearch>[0]['foundation'] = {
    debouncedQuery: '',
    selectedRepo: null,
    githubSourceContext: null,
    crossRepoSwitchTarget: 'project',
    disabled: false,
    handledCrossRepoUrlRef: { current: '' },
    repoSlugCacheRef: { current: new Map() },
    repoBackedSearchTargets: [{ repo, githubSourceContext: source, gitlabSourceContext: null }],
    ...store.getState(),
    setGithubItems: (change: React.SetStateAction<readonly GitHubWorkItem[]>) => {
      sharedItems = typeof change === 'function' ? change(sharedItems) : change
    },
    setGithubLoading: noop,
    setCrossRepoPrompt: noop
  }
  function Consumers() {
    useSmartWorkspaceGithubSearch({
      foundation,
      sourceQueryWithinLimit: true,
      shouldQueryGithub: true
    }) // SAFETY: only list branch fields are consumed.
    const model = useTaskPageGitHubSearchPagination({
      selectedRepos: [repo],
      currentPage: 0,
      appliedTaskSearch: '',
      paginationLoading,
      githubPerRepoPageLimit: 30,
      githubPageSize: 30,
      ...store.getState(),
      appliedTaskQuery: parseTaskQuery(''),
      githubWorkItemMutationQueryKey: 'q',
      githubViewerLogin: 'alice',
      pagesRef,
      currentPageRef,
      paginationGenerationRef: { current: 1 },
      countedTotalPagesRef: { current: null },
      setPaginationLoading: (v) => {
        paginationLoading = typeof v === 'function' ? v(paginationLoading) : v
        loading = paginationLoading
      },
      setLoadingTargetPage: noop,
      setCurrentPage: (v) => {
        currentPageRef.current = typeof v === 'function' ? v(currentPageRef.current) : v
        destination = currentPageRef.current
      },
      setPages: (change: React.SetStateAction<typeof context.pages>) => {
        context.pages = typeof change === 'function' ? change(context.pages) : change
        pagesRef.current = context.pages
      },
      taskResumeApplied: false,
      taskSearchInput: '',
      activeTaskPreset: null,
      activeGithubTaskKind: 'issues',
      setAppliedTaskSearch: noop,
      setTasksFiltering: noop,
      setCountedTotalPages: noop,
      setProvenPageLimit: noop,
      githubSearchPersistReadyRef: { current: false }
    }) // SAFETY: complete page-click/list state; query persistence inactive.
    return <button onClick={() => void model.handleLoadNextPage(4)}>Load page five</button>
  }
  const node = document.createElement('div'),
    consumer = createRoot(node)
  await act(async () => consumer.render(<Consumers />))
  await act(async () => node.querySelector('button')!.click())
  direct.mockResolvedValue(returned)
  await click()
  sharedItems = [{ ...seed, title: 'New shared edit' }]
  pagesRef.current = context.pages
  await act(async () => gate.resolve({ items: [seed], sources: { issues: null, prs: null } }))
  expect(destination).toBe(4)
  expect(loading).toBe(false)
  expect(context.pages[4]?.[0].title).toBe('Accepted title')
  expect(sharedItems[0].title).toBe('New shared edit')
  await act(async () => consumer.unmount())
})

it.each(['read', 'capability'])(
  'disposes same-ID runtime attempts during %s on actual incarnation change, preserves continuity, and sends a fresh click to the new runtime',
  async (stage) => {
    const runtimeRepo: Repo = { ...repo, executionHostId: 'runtime:server' }
    context.openedItem = { ...seed, repoHostId: 'runtime:server' }
    context.openedSource = getTaskPageRepoSourceContext(runtimeRepo, 'github')!
    store.setState({ repos: [runtimeRepo] })
    const firstStatus = createCompatibleRuntimeStatusResponse('runtime-one')
    if (!firstStatus.ok) {
      throw new Error('fixture')
    }
    store
      .getState()
      .setRuntimeEnvironmentStatus('server', { status: firstStatus.result, checkedAt: 1 })
    const pending = Promise.withResolvers<unknown>()
    let runtimeId = 'runtime-one',
      hold = false
    const call = vi.fn(async ({ method }: { method: string }) =>
      method === 'status.get'
        ? hold && stage === 'capability'
          ? pending.promise
          : createCompatibleRuntimeStatusResponse(runtimeId)
        : hold
          ? pending.promise
          : { id: 'rpc', ok: true, result: returned, _meta: { runtimeId } }
    )
    Object.assign(window.api, { runtimeEnvironments: { call } })
    await mount()
    hold = true
    if (stage === 'capability') {
      clearRuntimeCompatibilityCacheForTests()
    }
    await click()
    const before = fieldsRenders
    await act(async () =>
      store
        .getState()
        .setRuntimeEnvironmentStatus('server', { status: firstStatus.result, checkedAt: 2 })
    )
    expect(fieldsRenders).toBe(before)
    runtimeId = 'runtime-two'
    hold = false
    const nextStatus = createCompatibleRuntimeStatusResponse(runtimeId)
    if (!nextStatus.ok) {
      throw new Error('fixture')
    }
    await act(async () =>
      store
        .getState()
        .setRuntimeEnvironmentStatus('server', { status: nextStatus.result, checkedAt: 3 })
    )
    await act(async () =>
      pending.resolve(
        stage === 'capability'
          ? createCompatibleRuntimeStatusResponse('runtime-one')
          : {
              id: 'old',
              ok: true,
              result: { ...returned, item: { ...returned.item, title: 'Obsolete runtime' } },
              _meta: { runtimeId: 'runtime-one' }
            }
      )
    )
    expect(container.querySelector('h1')?.textContent).not.toContain('Obsolete runtime')
    await click()
    expect(container.querySelector('h1')?.textContent).toContain('Accepted title')
  }
)

it('reconciles displaced weak/force/stronger raw returns and store commits with the current qualified twin owner', async () => {
  await mount()
  const weak = Promise.withResolvers<unknown>(),
    forced = Promise.withResolvers<unknown>(),
    strict = Promise.withResolvers<unknown>()
  list
    .mockReturnValueOnce(weak.promise)
    .mockReturnValueOnce(forced.promise)
    .mockReturnValueOnce(strict.promise)
  const fetch = store.getState().fetchWorkItems
  const r0 = fetch(repo.id, repo.path, 30, '', { sourceContext: source, force: false })
  const r1 = fetch(repo.id, repo.path, 30, '', { sourceContext: source, force: true })
  const r2 = fetch(repo.id, repo.path, 30, '', {
    sourceContext: source,
    force: true,
    noCache: true
  })
  await act(async () => {
    weak.resolve({ items: [seed], sources: { issues: null, prs: null } })
    await r0
  })
  expect(list).toHaveBeenCalledTimes(3)
  direct.mockResolvedValue(returned)
  await click()
  store.setState((state) => ({
    workItemsCache: {
      ...state.workItemsCache,
      [key]: {
        ...state.workItemsCache[key],
        data: [
          { ...seed, title: 'Newer target' },
          { ...seed, repoId: 'registered-twin', title: 'Wrong current twin' }
        ]
      }
    }
  }))
  let oldRows: readonly GitHubWorkItem[] = [],
    strictRows: readonly GitHubWorkItem[] = []
  await act(async () => {
    forced.resolve({ items: [seed], sources: { issues: null, prs: null } })
    oldRows = await r1
  })
  await act(async () => {
    strict.resolve({ items: [seed], sources: { issues: null, prs: null } })
    strictRows = await r2
  })
  expect(oldRows[0].title).toBe('Newer target')
  expect(strictRows[0].title).toBe('Newer target')
  expect(store.getState().workItemsCache[key].data?.[0].title).toBe('Newer target')
})

it('keeps an ordinary pending lease through an earlier dialog comment callback and an unrelated accepted Refresh', async () => {
  await mount()
  const rb = Promise.withResolvers<GitHubWorkItemDetails | null>(),
    post = Promise.withResolvers<unknown>()
  const [bKey, bEntry] = [...workItemDetailsCache.entries()][0]
  direct.mockReturnValueOnce(rb.promise)
  await act(async () => touchWorkItemDetailsCache(bKey, { ...bEntry, fetchedAt: 0 }))
  const bPending = workItemDetailsCache.get(bKey)?.pending
  expect(bPending).toBeDefined()
  postComment.mockReturnValueOnce(post.promise)
  await draft('Comment draft', 'Reply while loading')
  await click('Send comment')
  context.openedItem = { ...seed, id: 'issue:6', number: 6, url: 'https://github.com/o/r/issues/6' }
  const a = {
    ...returned,
    item: { ...returned.item, number: 6, url: context.openedItem.url, title: 'Task A' }
  }
  direct.mockResolvedValue(a)
  await mount()
  await act(async () =>
    post.resolve({
      ok: true,
      comment: {
        id: 11,
        author: 'alice',
        authorAvatarUrl: '',
        body: 'B comment',
        createdAt: '',
        url: seed.url
      }
    })
  )
  expect(workItemDetailsCache.get(bKey)?.pending).toBe(bPending)
  await click()
  await act(async () =>
    rb.resolve({ ...oldDetails, item: { ...oldDetails.item, title: 'Useful later B title' } })
  )
  expect(workItemDetailsCache.get(bKey)?.details?.item.title).toBe('Useful later B title')
  expect(workItemDetailsCache.get(bKey)?.pending).toBeUndefined()
  expect(container.querySelector('h1')?.textContent).toContain('Task A')
})

it.each([
  ['matching GHES', 'https://ghe.example:8443/o/r/issues/5', {}, true],
  [
    'different GHES port',
    'https://ghe.example:8443/o/r/issues/5',
    { url: 'https://ghe.example/o/r/issues/5' },
    false
  ],
  ['different host', seed.url, { url: 'https://ghe.example/o/r/issues/5' }, false],
  ['different type', seed.url, { url: 'https://github.com/o/r/pull/5', type: 'pr' }, false],
  ['different number', seed.url, { url: 'https://github.com/o/r/issues/6', number: 6 }, false],
  ['inconsistent metadata', seed.url, { number: 6 }, false],
  ['unparseable equal URLs', 'not-an-issue', {}, false]
] as const)(
  'qualifies new addressed destinations from actual ordinary %s data without rejecting its conversation',
  async (_name, url, change, matches) => {
    context.openedItem = { ...seed, url }
    const loaded = {
      ...oldDetails,
      item: { ...seed, title: 'Loaded addressed title', url, ...change }
    }
    direct.mockResolvedValue(loaded)
    await mount()
    expect(direct).toHaveBeenCalledTimes(1)
    const title = matches ? loaded.item.title : seed.title
    expect(container.querySelector('h1')?.textContent).toContain(title)
    expect(JSON.parse(container.querySelector('[data-editor-item]')!.textContent!)).toMatchObject({
      title,
      url,
      id: seed.id,
      repoId: repo.id
    })
    expect(
      JSON.parse(container.querySelector('[data-conversation-item]')!.textContent!)
    ).toMatchObject(matches ? { title, url, id: seed.id } : loaded.item)
    await click('Start workspace from issue')
    expect(useItem).toHaveBeenLastCalledWith(expect.objectContaining({ title, url, id: seed.id }))
  }
)
