// @vitest-environment happy-dom
import './github-task-refresh.test-fixture'
import { parseTaskQuery } from '../../../shared/task-query'

import {
  context,
  store,
  mount,
  direct,
  list,
  update,
  taskMutation,
  harnessSetPages,
  container
} from './github-task-refresh.test-fixture'

import {
  repo,
  source,
  seed,
  user,
  key as initialCacheKey
} from './github-task-refresh-data.test-fixture'

import { act } from 'react'

import { expect, it, vi } from 'vitest'

import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

import { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'

import { getTaskPageRepoSourceContext } from '@/lib/task-repo-source-context'

import { getGitHubTaskObservation } from './github-task-observation'

import { gitHubTaskFamilyOrigin } from './github-task-observation'

import { createTaskPageGitHubReviewerActions } from '@/components/task-page/github/task-page-github-reviewer-actions'

import {
  createTaskPageGitHubProjectionContext,
  materializeTaskPageItemList
} from '@/components/task-page/github/task-page-github-work-item-mutation-pages'

import { reconcileTaskPagePagesWithWorkItemsCache } from '@/components/task-page/task-page-cache-selectors'

import { applyPendingTaskPageGitHubMutationsToItems } from '@/components/task-page/github/task-page-github-work-item-mutation-pages'

import { VisibleReaders } from './github-task-refresh-visible-readers.test-fixture'

it.each(
  (['assignees', 'reviewRequests'] as const).flatMap((family) => [
    { family, login: 'cora', succeeds: true, remove: false },
    { family, login: 'cora', succeeds: false, remove: false },
    { family, login: 'bob', succeeds: true, remove: false },
    { family, login: 'bob', succeeds: true, remove: true },
    { family, login: 'bob', succeeds: false, remove: true },
    { family, login: 'cora', succeeds: false, remove: false, fullBeforeFailure: 'bob' },
    { family, login: 'cora', succeeds: false, remove: false, fullBeforeFailure: 'bob,cora' },
    {
      family,
      login: 'cora',
      succeeds: false,
      remove: false,
      fullBeforeFailure: 'bob',
      resetBeforeFull: true
    },
    {
      family,
      login: 'cora',
      succeeds: false,
      remove: false,
      fullBeforeFailure: 'bob,cora',
      resetBeforeFull: true
    },
    { family, login: 'cora', succeeds: false, remove: false, resetBeforeFull: true },
    { family, login: 'cora', succeeds: true, remove: false, resetBeforeFull: true }
  ])
)(
  'traces a new B-owned $family edit of $login (remove=$remove, success=$succeeds) before B adopts its A seed',
  async ({ family, login, succeeds, remove, fullBeforeFailure, resetBeforeFull }) => {
    const isIssue = family === 'assignees'
    let query = `is:open ${isIssue ? 'assignee' : 'review-requested'}:@me`
    window.api.gh.viewer = vi.fn().mockResolvedValue({ login: 'bob' })
    const sources = {
      issues: { owner: 'o', repo: 'r' },
      prs: { owner: 'o', repo: 'r' }
    }
    const opening: GitHubWorkItem = {
      ...seed,
      type: isIssue ? 'issue' : 'pr',
      id: isIssue ? 'issue:5' : 'pr:5',
      url: `https://github.com/o/r/${isIssue ? 'issues' : 'pull'}/5`,
      title: 'Retained account A seed',
      ...(!isIssue
        ? {
            checksSummary: {
              state: 'success' as const,
              total: 0,
              passed: 0,
              failed: 0,
              pending: 0,
              neutral: 0
            }
          }
        : {}),
      [family]: [user('alice'), ...(remove ? [user('bob')] : [])]
    }
    const control: GitHubWorkItem = {
      ...opening,
      id: isIssue ? 'issue:6' : 'pr:6',
      number: 6,
      url: `https://github.com/o/r/${isIssue ? 'issues' : 'pull'}/6`,
      title: 'Untouched neighboring control'
    }
    list.mockResolvedValueOnce({ items: [opening, control], sources })
    const admitted = await store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: source })
    let cacheKey = Object.keys(store.getState().workItemsCache).find((key) => key.endsWith(query))!
    const aOwner = getGitHubTaskObservation(admitted[0])!
    const foreign = admitted[1]
    const foreignCacheRow = store.getState().workItemsCache[initialCacheKey].data![1]
    const originalControlData = JSON.stringify(foreign)
    const originalForeignData = JSON.stringify(foreignCacheRow)
    context.pages = [null, null, admitted]
    let queryKey = '',
      viewer: string | null = null
    const outputs = (
      pages: (GitHubWorkItem[] | null)[],
      mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>,
      key: string,
      viewerLogin: string | null
    ) => {
      queryKey = key
      viewer = viewerLogin
      return (
        <VisibleReaders
          pages={pages}
          mutation={mutation}
          queryKey={key}
          viewerLogin={viewerLogin}
          query={query}
          kind={isIssue ? 'issues' : 'prs'}
        />
      )
    }
    await mount(false, outputs, query, true)
    const snapshots: unknown[] = []
    const snapshot = (stage: string) => {
      const entry = store.getState().workItemsCache[cacheKey]
      const describe = (row: GitHubWorkItem) => ({
        id: row.id,
        url: row.url,
        family: row[family]?.map((u) => u.login),
        observation: getGitHubTaskObservation(row),
        origin: gitHubTaskFamilyOrigin(row, family)
      })
      const visible = [...container.querySelectorAll('[data-tasks] h3')].map(
        (node) => node.textContent
      )
      const result = {
        stage,
        viewer,
        registeredAccount: store.getState().repos[0].ghAccount,
        visible,
        count: container.querySelector('[data-visible-count]')?.textContent,
        avatars: [...container.querySelectorAll('[data-tasks] img')].map(
          (img) => img.getAttribute('title') ?? img.getAttribute('alt')
        ),
        reviewerLabels: [...container.querySelectorAll('[data-tasks] button[title]')].map(
          (button) => button.getAttribute('title')
        ),
        page: context.pages[2]?.map(describe),
        cache: entry.data?.map(describe),
        fullFetchObservation: entry.fullFetchObservation
      }
      snapshots.push(result)
      if (
        !fullBeforeFailure ||
        stage === 'A admitted' ||
        stage === 'B active, B list held, no B adoption' ||
        stage === 'new B edit pending'
      ) {
        expect(context.pages[2]![1], stage).toBe(foreign)
        expect(entry.data![1], stage).toBe(foreign)
      }
      expect(store.getState().workItemsCache[initialCacheKey].data![1], stage).toBe(foreignCacheRow)
      expect(JSON.stringify(foreign), stage).toBe(originalControlData)
      expect(JSON.stringify(foreignCacheRow), stage).toBe(originalForeignData)
      return result
    }
    const initial = snapshot('A admitted')
    await act(async () => {
      expect(
        await store
          .getState()
          .updateRepo(
            repo.id,
            { ghAccount: { host: 'github.com', user: 'bob' } },
            { hostId: 'local' }
          )
      ).toBe(true)
    })
    const bList = Promise.withResolvers<{ items: GitHubWorkItem[]; sources: typeof sources }>()
    list.mockReturnValueOnce(bList.promise)
    const bRead = store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: source })
    await act(async () => {
      await Promise.resolve()
    })
    const before = snapshot('B active, B list held, no B adoption')
    expect(list).toHaveBeenCalledTimes(2)
    expect(viewer).toBe('bob')
    expect(store.getState().workItemsCache[cacheKey].fullFetchObservation).toBe(aOwner)
    const ordinaryDirects = direct.mock.calls.length
    const response = Promise.withResolvers<{ ok: boolean; error?: string }>()
    const dispatch = vi.fn((_args: unknown) => {
      expect(store.getState().repos[0].ghAccount?.user).toBe('bob')
      return response.promise
    })
    update.mockImplementation(dispatch)
    Object.assign(window.api.gh, { requestPRReviewers: dispatch, removePRReviewers: dispatch })
    let operation: Promise<unknown>
    await act(async () => {
      const item = context.pages[2]![0]
      const currentRepo = store.getState().repos[0]
      operation = isIssue
        ? taskMutation.run({
            item,
            sourceContext: source,
            intent: { type: 'toggleAssignee', user: user(login) },
            mutate: () =>
              window.api.gh.updateIssue({
                repoPath: currentRepo.path,
                repoId: currentRepo.id,
                sourceContext: source,
                number: item.number,
                updates: remove ? { removeAssignees: [login] } : { addAssignees: [login] }
              }),
            errorToast: 'Rejected'
          })
        : createTaskPageGitHubReviewerActions({
            item,
            repo: currentRepo,
            localReviewRequests: item.reviewRequests ?? [],
            reviewRepo: { owner: 'o', repo: 'r' },
            reviewerCandidates: [user(login)],
            reviewerInput: '',
            selectedReviewerLogins: new Set(item.reviewRequests?.map((u) => u.login)),
            setLocalReviewRequests: () => {},
            setOpen: () => {},
            setReviewerInput: () => {},
            setSubmitting: () => {},
            sourceContext: source,
            ownerTarget: { kind: 'local' },
            submitting: false,
            workItemMutation: taskMutation
          }).requestReviewer(user(login))
      await Promise.resolve()
    })
    const pending = snapshot('new B edit pending')
    if (resetBeforeFull) {
      query = 'is:open'
      await mount(false, outputs, query, true)
    }
    if (fullBeforeFailure) {
      await act(async () => {
        bList.reject(new Error('B list unavailable'))
        await expect(bRead).rejects.toThrow('B list unavailable')
      })
      const providerUsers = fullBeforeFailure.split(',').map(user)
      list.mockResolvedValueOnce({
        items: [{ ...opening, [family]: providerUsers }, control],
        sources
      })
      await act(async () => {
        await store
          .getState()
          .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: source, force: true })
        cacheKey = Object.keys(store.getState().workItemsCache).find((key) => key.endsWith(query))!
        harnessSetPages((current) =>
          reconcileTaskPagePagesWithWorkItemsCache(current, [
            store.getState().workItemsCache[cacheKey]
          ]).map((page) =>
            page
              ? applyPendingTaskPageGitHubMutationsToItems(
                  page,
                  createTaskPageGitHubProjectionContext(
                    store.getState().repos,
                    parseTaskQuery(query),
                    queryKey,
                    viewer
                  )
                )
              : null
          )
        )
      })
      const fullPending = snapshot(
        resetBeforeFull
          ? 'B full after query reset, Cora still pending'
          : 'B full admitted, Cora still pending'
      )
      expect
        .soft(
          context.pages[2]?.[0][family]?.map((u) => u.login),
          'pending output after genuine full admission'
        )
        .toContain('cora')
      if (isIssue) {
        expect.soft(fullPending.avatars, 'actual pending row avatars').toContain('cora (cora)')
      } else {
        expect.soft(fullPending.reviewerLabels, 'actual pending reviewer chip').toContain('bob +1')
      }
      expect
        .soft(
          container.querySelector('[data-tasks]')?.textContent,
          'actual row remains visible while writing'
        )
        .toContain(opening.title)
    }
    await act(async () => {
      response.resolve(succeeds ? { ok: true } : { ok: false, error: 'Denied' })
      await operation!
    })
    const settled = snapshot(
      succeeds ? 'B per-login success only' : 'B per-login failure rolled back'
    )
    if (!fullBeforeFailure) {
      await act(async () => {
        bList.reject(new Error('B list unavailable'))
        await expect(bRead).rejects.toThrow('B list unavailable')
      })
    }
    const failedRead = snapshot('B list failed, A full-fetch descriptor retained')
    expect(store.getState().workItemsCache[cacheKey].fullFetchObservation?.account?.user).toBe(
      fullBeforeFailure ? 'bob' : 'alice'
    )
    if (fullBeforeFailure) {
      expect(context.pages[2]?.[0][family]?.map((u) => u.login)).toEqual(
        fullBeforeFailure.split(',')
      )
      expect(
        store.getState().workItemsCache[cacheKey].data?.[0][family]?.map((u) => u.login)
      ).toEqual(fullBeforeFailure.split(','))
      expect(gitHubTaskFamilyOrigin(context.pages[2]![0], family)?.kind).toBe('ordinary')
    }
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: repo.id,
        repoPath: repo.path,
        sourceContext: source,
        ...(isIssue
          ? { updates: remove ? { removeAssignees: [login] } : { addAssignees: [login] } }
          : { reviewers: [login] })
      })
    )
    expect(direct).toHaveBeenCalledTimes(ordinaryDirects)
    // A genuine B list response (after Bob is added back for the remove control) supplies the first complete B family.
    const bItem = {
      ...opening,
      [family]: [user('bob'), ...(login === 'cora' && succeeds ? [user('cora')] : [])]
    }
    list.mockResolvedValueOnce({
      items: [bItem, { ...control, [family]: [user('alice'), user('bob')] }],
      sources
    })
    await act(async () => {
      const rows = await store
        .getState()
        .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: source, force: true })
      cacheKey = Object.keys(store.getState().workItemsCache).find((key) => key.endsWith(query))!
      harnessSetPages((pages) => [
        null,
        null,
        materializeTaskPageItemList({
          networkItems: rows,
          previousItems: pages[2] ?? [],
          queryKey,
          context: createTaskPageGitHubProjectionContext(
            store.getState().repos,
            parseTaskQuery(query),
            queryKey,
            viewer
          )
        })
      ])
    })
    // A real full read may legitimately replace the control's observation metadata.
    const after = {
      visible: [...container.querySelectorAll('[data-tasks] h3')].map((node) => node.textContent),
      count: container.querySelector('[data-visible-count]')?.textContent,
      page: context.pages[2]?.map((row) => ({
        id: row.id,
        family: row[family]?.map((u) => u.login),
        observation: getGitHubTaskObservation(row),
        origin: gitHubTaskFamilyOrigin(row, family)
      })),
      cache: store.getState().workItemsCache[cacheKey],
      viewer
    }
    console.info(
      'BSEED_TRACE',
      JSON.stringify({
        family,
        login,
        succeeds,
        remove,
        route: dispatch.mock.calls,
        snapshots,
        genuineB: after
      })
    )
    expect(initial.visible).toContain(opening.title)
    expect(before.visible).toContain(opening.title)
    if (!remove) {
      expect.soft(after.visible, 'genuine B full observation/reentry').toContain(opening.title)
    }
    expect(store.getState().workItemsCache[cacheKey].fullFetchObservation?.account?.user).toBe(
      'bob'
    )
    expect(list).toHaveBeenCalledTimes(fullBeforeFailure ? 4 : 3)
    for (const state of [pending, settled, failedRead]) {
      expect
        .soft(state.visible.includes(opening.title), state.stage)
        .toBe(!remove || (!succeeds && state !== pending))
      expect
        .soft(state.count, state.stage)
        .toBe(remove && (succeeds || state === pending) ? '1' : '2')
    }
  }
)
it('keeps the existing owner-selected registry subscription quiet for unrelated and foreign updates in separate act turns', async () => {
  const remote = {
    ...repo,
    path: '/ssh/repo',
    executionHostId: 'ssh:builder' as const,
    connectionId: 'builder'
  }
  store.setState({ repos: [repo, remote] })
  const remoteSource = getTaskPageRepoSourceContext(remote, 'github')!
  const counts = [0, 0]
  const runners: ReturnType<typeof useTaskPageGitHubWorkItemMutation>[] = []
  const repos = [[repo], [remote]]
  function Observer({ index }: { index: number }) {
    const runner = useTaskPageGitHubWorkItemMutation({
      repos: repos[index],
      query: parseTaskQuery('is:open'),
      queryKey: 'q',
      viewerLogin: 'alice',
      patchWorkItem: store.getState().patchWorkItem
    })
    runners[index] = runner
    counts[index]++
    return (
      <output data-owner={index}>
        {runner.isIntentPending({
          item: { ...seed, repoHostId: index ? 'ssh:builder' : 'local' },
          sourceContext: index ? remoteSource : source,
          intent: { type: 'toggleAssignee', user: user('bob') }
        })
          ? 'pending'
          : 'idle'}
      </output>
    )
  }
  await act(async () =>
    context.root.render(
      <>
        <Observer index={0} />
        <Observer index={1} />
      </>
    )
  )
  const settled = [...counts]
  await act(async () => store.setState({ workItemsInvalidationNonce: 100 }))
  expect(counts).toEqual(settled)
  const pending = Promise.withResolvers<{ ok: boolean }>()
  let completion: Promise<unknown>
  await act(async () => {
    completion = runners[0].run({
      item: { ...seed, repoHostId: 'local' },
      sourceContext: source,
      intent: { type: 'toggleAssignee', user: user('bob') },
      mutate: () => pending.promise,
      errorToast: 'Rejected'
    })
  })
  expect(counts[0]).toBeGreaterThan(settled[0])
  expect(counts[1]).toBe(settled[1])
  expect(container.querySelector('[data-owner="0"]')?.textContent).toBe('pending')
  const afterStart = [...counts]
  await act(async () => {
    pending.resolve({ ok: false })
    await completion!
  })
  expect(counts[0]).toBeGreaterThan(afterStart[0])
  expect(counts[1]).toBe(afterStart[1])
  expect(container.querySelector('[data-owner="0"]')?.textContent).toBe('idle')
  const beforeForeign = [...counts]
  await act(async () => {
    await runners[1].run({
      item: { ...seed, repoHostId: 'ssh:builder' },
      sourceContext: remoteSource,
      intent: { type: 'toggleAssignee', user: user('bob') },
      mutate: async () => ({ ok: true }),
      errorToast: 'Rejected'
    })
  })
  expect(counts[0]).toBe(beforeForeign[0])
  expect(counts[1]).toBeGreaterThan(beforeForeign[1])
})

it.each([false, true])(
  'hands repeated resets and a real aggregate composed fallback through delayed final setters (provider Cora=%s)',
  async (providerCora) => {
    const { beginGitHubTaskRead } = await import('@/store/github/request-coordination')
    const { restoreTaskPageGitHubReadPage } =
      await import('@/components/task-page/github/task-page-github-work-item-mutation-pages')
    const { taskPageGitHubResumeCache } =
      await import('@/components/task-page/github/task-page-github-resume-cache')
    const sources = { issues: { owner: 'o', repo: 'r' }, prs: { owner: 'o', repo: 'r' } }
    await store
      .getState()
      .updateRepo(repo.id, { ghAccount: { host: 'github.com', user: 'bob' } }, { hostId: 'local' })
    const ordinary = { ...seed, assignees: [user('bob')] }
    list.mockResolvedValueOnce({ items: [ordinary], sources })
    const rows = await store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, 'is:open', { sourceContext: source })
    const foreign = store.getState().workItemsCache[initialCacheKey].data![1]
    const foreignData = JSON.stringify(foreign)
    context.pages = [null, null, rows]
    const outputs = (
      pages: (GitHubWorkItem[] | null)[],
      mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>,
      queryKey: string,
      viewerLogin: string | null
    ) => (
      <VisibleReaders
        pages={pages}
        mutation={mutation}
        queryKey={queryKey}
        viewerLogin={viewerLogin}
        query="is:open"
        kind="issues"
      />
    )
    await mount(false, outputs, 'is:open', true)
    await act(async () => {
      await taskMutation.run({
        item: context.pages[2]![0],
        sourceContext: source,
        intent: { type: 'toggleAssignee', user: user('bob') },
        mutate: async () => ({ ok: true }),
        errorToast: 'Rejected'
      })
    })
    const response = Promise.withResolvers<{ ok: boolean }>()
    let writing: Promise<unknown>
    await act(async () => {
      writing = taskMutation.run({
        item: context.pages[2]![0],
        sourceContext: source,
        intent: { type: 'toggleAssignee', user: user('cora') },
        mutate: () => response.promise,
        errorToast: 'Rejected'
      })
    })
    const composed = context.pages[2]![0]
    expect(composed.assignees?.map((user) => user.login)).toEqual(['cora'])
    taskPageGitHubResumeCache.write('held-output', 2, [composed], 10)
    const read = beginGitHubTaskRead(
      [{ repoId: repo.id, path: repo.path, sourceContext: source }],
      undefined,
      store.getState()
    )
    const failed = Promise.withResolvers<never>()
    list.mockReturnValueOnce(failed.promise)
    const aggregate = store
      .getState()
      .fetchWorkItemsAcrossRepos(
        [{ repoId: repo.id, path: repo.path, sourceContext: source }],
        30,
        30,
        'is:open',
        { force: true, taskRead: read }
      )
    let fallback: Awaited<typeof aggregate>
    await act(async () => {
      failed.reject(new Error('Expected fallback'))
      fallback = await aggregate
    })
    expect(fallback!.items[0].assignees?.map((user) => user.login)).toEqual(['cora'])
    context.holdPageUpdates()
    await mount(false, outputs, 'is:open assignee:cora', true)
    await mount(false, outputs, 'is:open', true)
    const provider = [user('bob'), ...(providerCora ? [user('cora')] : [])]
    list.mockResolvedValueOnce({ items: [{ ...ordinary, assignees: provider }], sources })
    await act(async () => {
      await store
        .getState()
        .fetchWorkItems(repo.id, repo.path, 30, 'is:open', { sourceContext: source, force: true })
      response.resolve({ ok: false })
      await writing!
    })
    // The actual aggregate raw fallback outlives the two resets and final acknowledgement.
    harnessSetPages((current) => restoreTaskPageGitHubReadPage(read, current, fallback!.items, 2))
    read.dispose()
    await act(async () => context.flushPageUpdates())
    expect(context.pages[2]![0].assignees).toEqual(provider)
    expect(container.querySelector('[data-tasks]')?.textContent).toContain(ordinary.title)
    const avatars = [...container.querySelectorAll('[data-tasks] img')].map((img) =>
      img.getAttribute('title')
    )
    expect(avatars).toContain('bob (bob)')
    expect(avatars.includes('cora (cora)')).toBe(providerCora)
    expect(gitHubTaskFamilyOrigin(context.pages[2]![0], 'assignees')?.kind).toBe('ordinary')
    expect(taskPageGitHubResumeCache.read('held-output', 2, 11)?.items[0].assignees).toEqual(
      provider
    )
    expect(store.getState().workItemsCache[initialCacheKey].data![1]).toBe(foreign)
    expect(JSON.stringify(foreign)).toBe(foreignData)
    expect(list).toHaveBeenCalledTimes(3)
  }
)
