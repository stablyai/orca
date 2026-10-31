// @vitest-environment happy-dom
import {
  context,
  store,
  mount,
  click,
  direct,
  list,
  taskMutation,
  harnessSetPages,
  container
} from './github-task-refresh.test-fixture'

import { getTaskPageGitHubMutationQueryKey } from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import { parseTaskQuery } from '../../../shared/task-query'

import { repo, source, seed, returned, user } from './github-task-refresh-data.test-fixture'
import { act } from 'react'
import { expect, it, vi } from 'vitest'

import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'

import { getTaskPageRepoSourceContext } from '@/lib/task-repo-source-context'
import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import {
  createTaskPageGitHubProjectionContext,
  materializeTaskPageItemList
} from '@/components/task-page/github/task-page-github-work-item-mutation-pages'

import { VisibleReaders } from './github-task-refresh-visible-readers.test-fixture'

it('uses the captured registered query actor through direct Refresh, final avatars/count and ordinary reviewer failure rollback', async () => {
  const globalViewer = Promise.withResolvers<{ login: string }>()
  window.api.gh.viewer = vi.fn().mockReturnValue(globalViewer.promise)
  const query = 'is:open assignee:@me'
  const opening = { ...seed, id: 'issue:5', assignees: [user('alice')] }
  const sources = { issues: { owner: 'o', repo: 'r' }, prs: null }
  list.mockResolvedValueOnce({ items: [opening], sources })
  const admitted = await store
    .getState()
    .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: source })
  context.pages = [null, null, admitted]
  const outputs = (
    pages: (readonly GitHubWorkItem[] | null)[],
    mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>,
    key: string,
    viewerLogin: string | null
  ) => (
    <VisibleReaders
      pages={pages}
      mutation={mutation}
      queryKey={key}
      viewerLogin={viewerLogin}
      query={query}
    />
  )
  await mount(false, outputs, query, true)
  const task = () => container.querySelector('[data-tasks] h3')
  expect(task()).not.toBeNull()
  expect(window.api.gh.viewer).toHaveBeenCalledOnce()
  expect(list).toHaveBeenCalledWith(
    expect.objectContaining({ repoId: repo.id, repoPath: repo.path, query })
  )
  const calls = list.mock.calls.length
  const initialDirectCalls = direct.mock.calls.length
  let viewerResolved = false
  for (const [assignees, visible] of [
    [[user('alice')], true],
    [[user('bob')], false],
    [[], false],
    [[user('alice')], true]
  ] as const) {
    direct.mockResolvedValue({ ...returned, item: { ...returned.item, assignees: [...assignees] } })
    await click()
    expect(!!task()).toBe(visible)
    expect(container.querySelector('[data-visible-count]')?.textContent).toBe(visible ? '1' : '0')
    if (visible) {
      expect(container.querySelector('[data-tasks] img[title="alice (alice)"]')).not.toBeNull()
    }
    if (!viewerResolved) {
      await act(async () => {
        globalViewer.resolve({ login: 'bob' })
      })
      viewerResolved = true
      expect(task()).not.toBeNull() // Late ambient viewer cannot replace the registered actor.
    }
    if (!visible) {
      const queryKey = getTaskPageGitHubMutationQueryKey()!
      const projected = materializeTaskPageItemList({
        networkItems: [],
        previousItems: context.pages[2]!,
        queryKey,
        context: createTaskPageGitHubProjectionContext(
          [repo],
          parseTaskQuery(query),
          queryKey,
          'bob'
        )
      })
      expect(projected).toHaveLength(1)
      await act(async () => harnessSetPages([null, null, projected]))
      expect(task()).toBeNull()
    }
  }
  expect(direct).toHaveBeenLastCalledWith(
    expect.objectContaining({ repoId: repo.id, sourceContext: source })
  )
  expect(list).toHaveBeenCalledTimes(calls)

  const pr = {
    ...opening,
    type: 'pr' as const,
    id: 'pr:5',
    url: 'https://github.com/o/r/pull/5',
    title: 'Requested review',
    checksSummary: {
      state: 'success' as const,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      neutral: 0
    },
    reviewRequests: [user('alice')]
  }
  const reviewQuery = 'is:open review-requested:@me'
  context.pages = [null, null, [pr]]
  await act(async () => harnessSetPages(context.pages))
  const reviewOutputs = (
    pages: (readonly GitHubWorkItem[] | null)[],
    mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>,
    key: string,
    viewerLogin: string | null
  ) => (
    <VisibleReaders
      pages={pages}
      mutation={mutation}
      queryKey={key}
      viewerLogin={viewerLogin}
      query={reviewQuery}
      kind="prs"
    />
  )
  await mount(false, reviewOutputs, reviewQuery, true)
  const { createTaskPageGitHubReviewerActions } =
    await import('@/components/task-page/github/task-page-github-reviewer-actions')
  const requestReviewers = vi.fn().mockResolvedValue({ ok: true })
  const removeReviewers = vi.fn()
  Object.assign(window.api.gh, {
    requestPRReviewers: requestReviewers,
    removePRReviewers: removeReviewers
  })
  const request = (login: string) => {
    const item = context.pages[2]![0]
    return createTaskPageGitHubReviewerActions({
      item,
      localReviewRequests: item.reviewRequests ?? [],
      repo,
      reviewRepo: { owner: 'o', repo: 'r' },
      reviewerCandidates: [user('cora')],
      reviewerInput: '',
      selectedReviewerLogins: new Set(item.reviewRequests?.map((reviewer) => reviewer.login)),
      setLocalReviewRequests: () => {},
      setOpen: () => {},
      setReviewerInput: () => {},
      setSubmitting: () => {},
      sourceContext: source,
      ownerTarget: { kind: 'local' },
      submitting: false,
      workItemMutation: taskMutation
    }).requestReviewer(user(login))
  }
  await act(async () => {
    await request('cora')
  })
  expect(task()?.textContent).toBe('Requested review')
  const failed = Promise.withResolvers<{ ok: boolean; error?: string }>()
  removeReviewers.mockReturnValueOnce(failed.promise)
  let removal: Promise<void>
  await act(async () => {
    removal = request('alice')
    await Promise.resolve()
  })
  expect(task()).toBeNull()
  await act(async () => {
    failed.resolve({ ok: false, error: 'Denied' })
    await removal!
  })
  expect(task()?.textContent).toBe('Requested review')
  expect(context.pages[2]![0].reviewRequests?.map((reviewer) => reviewer.login)).toEqual([
    'alice',
    'cora'
  ])
  removeReviewers.mockResolvedValue({ ok: true })
  await act(async () => {
    await request('alice')
  })
  expect(task()).toBeNull()
  expect(requestReviewers).toHaveBeenCalledOnce()
  expect(removeReviewers).toHaveBeenCalledTimes(2)
  expect(direct).toHaveBeenCalledTimes(initialDirectCalls + 4) // No PR Refresh.
})
it('retains the common actor compatibility policy for unbound, unknown, remote and named/state inputs', async () => {
  const { createTaskPageGitHubMembershipProjection, establishTaskPageGitHubMembership } =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-composition')
  const { shouldSkipLocalViewerQualifiers } = await import('./task-repo-source-context')
  const { captureGitHubTaskObservation, observeGitHubWorkItem } =
    await import('./github-task-observation')
  for (const mode of ['bound', 'unbound', 'unknown', 'ssh', 'runtime', 'ghes'] as const) {
    const owner = {
      ...repo,
      ghAccount:
        mode === 'unbound'
          ? undefined
          : { host: mode === 'ghes' ? 'ghe.example' : 'GitHub.com', user: ' Alice ' },
      executionHostId:
        mode === 'ssh'
          ? ('ssh:builder' as const)
          : mode === 'runtime'
            ? ('runtime:builder' as const)
            : ('local' as const)
    }
    const source = getTaskPageRepoSourceContext(owner, 'github')!
    const captured = captureGitHubTaskObservation(owner, source)!
    const observation = mode === 'unknown' ? { ...captured, account: undefined } : captured
    const row = observeGitHubWorkItem(
      {
        ...seed,
        assignees: [user('alice')],
        url: mode === 'ghes' ? 'https://ghe.example/o/r/issues/5' : seed.url
      },
      observation
    )
    establishTaskPageGitHubMembership({
      item: row,
      observation,
      sourceScope: getTaskSourceCacheScope(source),
      queryKey: 'q',
      skipMeQualifiers: shouldSkipLocalViewerQualifiers(source) || mode === 'ghes'
    })
    const project = (query: string, viewerLogin: string | null) =>
      createTaskPageGitHubMembershipProjection({
        query: parseTaskQuery(query),
        queryKey: 'q',
        viewerLogin
      })(
        row,
        getTaskSourceCacheScope(source),
        observation,
        shouldSkipLocalViewerQualifiers(source) || mode === 'ghes'
      )
    expect(project('assignee:@me', 'bob').hide, mode).toBe(mode === 'unbound')
    expect(project('assignee:@me', null).hide, mode).toBe(false)
    expect(project('assignee:cora', 'bob').hide, mode).toBe(true)
    expect(project('is:closed', 'bob').hide, mode).toBe(true)
  }
})
