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
import { parseTaskQuery } from '../../../shared/task-query'

import { repo, source, seed, returned, user } from './github-task-refresh-data.test-fixture'

import React, { act } from 'react'

import { expect, it, vi } from 'vitest'

import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

import type { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'

import { assertTaskPageGitHubDialogStateAuthority } from '@/components/task-page/github/task-page-github-dialog-state-authority'

import {
  buildTaskSourceContextFromRepo,
  getTaskSourceCacheScope
} from '../../../shared/task-source-context'

import {
  captureGitHubTaskObservation,
  observeGitHubWorkItem,
  getGitHubTaskObservation
} from './github-task-observation'

import {
  createTaskPageGitHubProjectionContext,
  materializeTaskPageItemList
} from '@/components/task-page/github/task-page-github-work-item-mutation-pages'

import { taskPageGitHubAuthorityItemKeys } from '@/components/task-page/github/task-page-github-work-item-mutation-keys'

import { clearTaskPageGitHubAuthorityAbsentFromLoadedItems } from '@/components/task-page/github/task-page-github-work-item-authority-refresh'

import {
  deleteLastConfirmedClientValue,
  getLastConfirmedClientEntry
} from '@/components/task-page/github/task-page-github-confirmed-client-values'

import { settleQuietSearchRevalidate } from '@/components/task-page/github/task-page-github-work-item-quiet-revalidate'

import { getOrCreateQuietRevalidateState } from '@/components/task-page/github/task-page-github-work-item-quiet-state'

import { VisibleReaders } from './github-task-refresh-visible-readers.test-fixture'

it('preserves the single raw scalar source/replacement/revert and ownerless PR lifetime through actual final filtering, ordinary adoption and reset', async () => {
  const local = observeGitHubWorkItem(
    { ...seed, id: 'issue:5', title: 'Fork', assignees: [user('bob')] },
    captureGitHubTaskObservation(repo, source)
  )
  const upstream = { ...local, title: 'Upstream', url: 'https://github.com/upstream/r/issues/5' }
  const legacy = buildTaskSourceContextFromRepo({ provider: 'github', projectId: repo.id, repo })!
  const scope = getTaskSourceCacheScope(legacy)
  context.pages = [null, null, [local, upstream]]
  let query = 'is:open',
    kind: 'issues' | 'prs' = 'issues'
  let queryKey = ''
  const outputs = (
    pages: (GitHubWorkItem[] | null)[],
    mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>,
    key: string,
    viewerLogin: string | null
  ) => {
    queryKey = key
    return (
      <VisibleReaders
        pages={pages}
        mutation={mutation}
        queryKey={key}
        viewerLogin={viewerLogin}
        query={query}
        kind={kind}
      />
    )
  }
  await mount(false, outputs, query, true)
  const visible = () =>
    [...container.querySelectorAll('[data-tasks] h3')].map((row) => row.textContent)
  const close = (owner: string, state: 'open' | 'closed' | 'merged' = 'closed') =>
    assertTaskPageGitHubDialogStateAuthority({
      repoId: repo.id,
      itemId: local.id,
      sourceContext: legacy,
      ownerRepo: { owner, repo: 'r', host: 'github.com' },
      state
    })
  let oldFork: ReturnType<typeof close>
  await act(async () => {
    close('upstream')
  })
  expect(visible()).toEqual(['Fork'])
  await act(async () => {
    oldFork = close('o')
  })
  expect(visible()).toEqual(['Upstream'])
  await act(async () => {
    close('upstream')
  })
  await act(async () => {
    expect(oldFork!.revert()).toBe(false)
  })
  expect(visible()).toEqual(['Fork'])
  expect(getLastConfirmedClientEntry(scope, repo.id, local.id, 'state')?.ownerRepo?.owner).toBe(
    'upstream'
  )
  const adopt = async (rows: GitHubWorkItem[]) => {
    await act(async () => {
      settleQuietSearchRevalidate({
        queryKey,
        networkItems: rows,
        fetchStartedAtGeneration: getOrCreateQuietRevalidateState(queryKey).dirtyGeneration,
        patchWorkItems: store.getState().patchWorkItems
      })
      harnessSetPages((current) => [
        null,
        null,
        materializeTaskPageItemList({
          networkItems: rows,
          previousItems: current[2] ?? [],
          queryKey,
          context: createTaskPageGitHubProjectionContext(
            store.getState().repos,
            parseTaskQuery(query),
            queryKey,
            'alice'
          )
        })
      ])
    })
  }
  await adopt([local, { ...upstream, state: 'closed' }])
  expect(getLastConfirmedClientEntry(scope, repo.id, local.id, 'state')).toBeUndefined()
  expect(visible()).toEqual(['Fork']) // matching adoption owns closed after the slot is gone
  await adopt([local, upstream])
  expect(visible()).toEqual(['Fork', 'Upstream'])
  await act(async () => {
    close('o')
    harnessSetPages((current) => [
      null,
      null,
      materializeTaskPageItemList({
        networkItems: [local, upstream],
        previousItems: current[2] ?? [],
        queryKey,
        context: createTaskPageGitHubProjectionContext(
          store.getState().repos,
          parseTaskQuery(query),
          queryKey,
          'alice'
        )
      })
    ])
  })
  expect(context.pages[2]?.[0].state).toBe('closed')
  expect(visible()).toEqual(['Upstream'])
  await act(async () => {
    deleteLastConfirmedClientValue(scope, repo.id, local.id, 'state')
  })
  expect(visible()).toEqual(['Fork', 'Upstream'])
  // A real query reset and subsequent list edit must not certify the dead scalar-written state.
  query = 'is:open assignee:bob'
  await mount(false, outputs, query, true)
  await act(async () => {
    await taskMutation.run({
      item: context.pages[2]![0],
      sourceContext: source,
      intent: { type: 'toggleAssignee', user: user('cora') },
      mutate: async () => ({ ok: true }),
      errorToast: 'Rejected'
    })
  })
  expect(visible()).toEqual(['Fork', 'Upstream'])
  await adopt([local, upstream])
  expect(visible()).toEqual(['Fork', 'Upstream'])
  // Ownerless ordinary PR authority uses the same raw slot through cleanup and stale materialization.
  query = 'is:pr is:open'
  kind = 'prs'
  const pr = observeGitHubWorkItem(
    {
      ...local,
      id: 'pr:5',
      type: 'pr',
      url: 'https://github.com/o/r/pull/5',
      title: 'Pull request',
      checksSummary: { state: 'success', total: 1, failed: 0, pending: 0, neutral: 0 }
    },
    captureGitHubTaskObservation(repo, source)
  )
  await act(async () => harnessSetPages([null, null, [pr]]))
  await mount(false, outputs, query, true)
  for (const state of ['closed', 'merged'] as const) {
    await act(async () => {
      assertTaskPageGitHubDialogStateAuthority({
        repoId: repo.id,
        itemId: pr.id,
        state,
        sourceContext: legacy
      })
      clearTaskPageGitHubAuthorityAbsentFromLoadedItems(
        new Set(taskPageGitHubAuthorityItemKeys(pr))
      )
      harnessSetPages((current) => [
        null,
        null,
        materializeTaskPageItemList({
          networkItems: [pr],
          previousItems: current[2] ?? [],
          queryKey,
          context: createTaskPageGitHubProjectionContext(
            store.getState().repos,
            parseTaskQuery(query),
            queryKey,
            'alice'
          )
        })
      ])
    })
    expect(context.pages[2]?.[0].state).toBe(state)
    expect(visible()).toEqual([])
  }
})
it.each([true, false])(
  'captures account observations and preserves raw lifetime over binding-only activation with old write success=%s',
  async (oldWriteSucceeds) => {
    let query = 'is:open assignee:@me'
    window.api.gh.viewer = vi.fn().mockResolvedValue({ login: 'bob' })
    const sources = {
      issues: { owner: 'o', repo: 'r' },
      prs: null,
      originCandidate: { owner: 'o', repo: 'r' },
      upstreamCandidate: null
    }
    const opening = { ...seed, id: 'issue:5', title: 'Account A', assignees: [user('alice')] }
    list.mockResolvedValueOnce({ items: [opening], sources })
    const aRows = await store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: source })
    const cacheKey = Object.keys(store.getState().workItemsCache).find((key) =>
      key.endsWith(query)
    )!
    context.pages = [null, null, [...aRows]]
    const outputs = (
      pages: (GitHubWorkItem[] | null)[],
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
    const visible = () =>
      [...container.querySelectorAll('[data-tasks] h3')].map((node) => node.textContent)
    let aAuthority: ReturnType<typeof assertTaskPageGitHubDialogStateAuthority>
    await act(async () => {
      aAuthority = assertTaskPageGitHubDialogStateAuthority({
        repoId: repo.id,
        itemId: opening.id,
        state: 'closed',
        sourceContext: source,
        ownerRepo: { owner: 'o', repo: 'r' }
      })
    })
    const scope = getTaskSourceCacheScope(source)
    const originalSlot = getLastConfirmedClientEntry(scope, repo.id, opening.id, 'state')
    expect(visible()).toEqual([])
    const old = Promise.withResolvers<{ items: GitHubWorkItem[]; sources: typeof sources }>()
    list.mockReturnValueOnce(old.promise)
    const oldRead = store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: source, force: true })
    const lateWrite = Promise.withResolvers<{ ok: boolean }>()
    let oldMutation: Promise<unknown>
    await act(async () => {
      oldMutation = taskMutation.run({
        item: aRows[0],
        sourceContext: source,
        intent: { type: 'toggleAssignee', user: user('cora') },
        mutate: () => lateWrite.promise,
        errorToast: 'Rejected'
      })
    })
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
    expect(getLastConfirmedClientEntry(scope, repo.id, opening.id, 'state')).toBe(originalSlot)
    expect(visible()).toEqual(['Account A'])
    const b = Promise.withResolvers<{ items: GitHubWorkItem[]; sources: typeof sources }>()
    list.mockReturnValueOnce(b.promise)
    const bRead = store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: source })
    await act(async () => {
      await Promise.resolve()
    })
    expect(list).toHaveBeenCalledTimes(3) // B neither reuses the fresh A cache nor joins the A promise.
    expect(
      getGitHubTaskObservation(store.getState().workItemsCache[cacheKey].data![0])?.binding
    ).toBe(getGitHubTaskObservation(aRows[0])?.binding)
    direct.mockResolvedValue({ ...returned, item: { ...returned.item, title: 'Account B' } })
    await click()
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh task"]')?.disabled
    ).toBe(true)
    await act(async () => {
      lateWrite.resolve({ ok: oldWriteSucceeds })
      await oldMutation!
    })
    expect(visible()).toEqual(['Account B'])
    const accepted = store.getState().workItemsCache[cacheKey].data![0]
    expect(getGitHubTaskObservation(accepted)?.binding).not.toBe(
      getGitHubTaskObservation(aRows[0])?.binding
    )
    expect(store.getState().workItemsCache[cacheKey].fullFetchObservation?.binding).toBe(
      getGitHubTaskObservation(aRows[0])?.binding
    )
    await act(async () => {
      old.resolve({ items: [{ ...opening, title: 'Late A' }], sources })
      await oldRead
    })
    expect(store.getState().workItemsCache[cacheKey].data![0]).toBe(accepted)
    await act(async () => {
      b.resolve({ items: [{ ...opening, title: 'Old B search' }], sources })
      await bRead
    })
    expect(store.getState().workItemsCache[cacheKey].data![0].title).toBe('Account B')
    await act(async () => {
      expect(
        await store
          .getState()
          .updateRepo(repo.id, { ghAccount: repo.ghAccount }, { hostId: 'local' })
      ).toBe(true)
    })
    expect(getLastConfirmedClientEntry(scope, repo.id, opening.id, 'state')).toBe(originalSlot)
    expect(visible()).toEqual([]) // A's same actual raw slot applies again.
    await act(async () => {
      await store
        .getState()
        .updateRepo(
          repo.id,
          { ghAccount: { host: 'github.com', user: 'bob' } },
          { hostId: 'local' }
        )
    })
    await act(async () => {
      assertTaskPageGitHubDialogStateAuthority({
        repoId: repo.id,
        itemId: opening.id,
        state: 'closed',
        sourceContext: source,
        ownerRepo: { owner: 'o', repo: 'r' }
      })
    })
    const replaced = getLastConfirmedClientEntry(scope, repo.id, opening.id, 'state')
    expect(replaced).not.toBe(originalSlot)
    await act(async () => {
      await store.getState().updateRepo(repo.id, { ghAccount: repo.ghAccount }, { hostId: 'local' })
    })
    expect(getLastConfirmedClientEntry(scope, repo.id, opening.id, 'state')).toBe(replaced)
    expect(visible()).toEqual(['Account B']) // Returning A cannot revive the replaced A entry.
    expect(aAuthority!.revert()).toBe(true) // main raw current-value/revert domain is unchanged
    query = 'is:open assignee:cora'
    await mount(false, outputs, query, true)
    expect(visible()).toEqual(['Account B']) // New server-admitted query has no prior local basis.
  }
)

it('seals the actual outer page updater across raw deletion and canonical sibling replacement', async () => {
  const { beginGitHubTaskRead } = await import('@/store/github/request-coordination')
  const { deliverTaskPageGitHubRead } =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-pages')
  const row = observeGitHubWorkItem(
    { ...seed, id: 'issue:5' },
    captureGitHubTaskObservation(repo, source)
  )
  const scope = getTaskSourceCacheScope(source)
  const close = (owner: string) =>
    assertTaskPageGitHubDialogStateAuthority({
      repoId: repo.id,
      itemId: row.id,
      sourceContext: source,
      ownerRepo: { owner, repo: 'r', host: 'github.com' },
      state: 'closed'
    })
  close('o')
  const { createTaskPageGitHubScalarAuthorityIndex } =
    await import('@/components/task-page/github/task-page-github-confirmed-client-values')
  const liveScalar = createTaskPageGitHubScalarAuthorityIndex()
  const read = beginGitHubTaskRead(
    [{ repoId: repo.id, sourceContext: source }],
    undefined,
    store.getState()
  )
  type Pages = (GitHubWorkItem[] | null)[]
  let queued: ((current: Pages) => Pages) | undefined
  const current: Pages = [null, null, [row]]
  const foreignRepo = { ...repo, id: 'foreign', executionHostId: 'ssh:foreign' as const }
  const projection = createTaskPageGitHubProjectionContext(
    [repo, foreignRepo],
    parseTaskQuery('is:open'),
    'q',
    'alice'
  )
  const fences = await import('@/store/host-catalog-fencing')
  const captureFence = vi.spyOn(fences, 'captureHostIdentityFence')
  try {
    deliverTaskPageGitHubRead(
      read,
      [row],
      (update) => {
        if (typeof update === 'function') {
          queued = update
        }
      },
      { current },
      projection,
      (pages, rows, materialize) => {
        const next = [...pages]
        while (next.length <= 2) {
          next.push(null)
        }
        next[2] = materialize(rows, pages[2] ?? [])
        return next
      }
    )
    expect(queued).toBeTypeOf('function')
    const before = queued!(current)
    expect(before[2]?.[0].state).toBe('closed')
    expect(getGitHubTaskObservation(before[2]![0])).toEqual(getGitHubTaskObservation(row))
    deleteLastConfirmedClientValue(scope, repo.id, row.id, 'state')
    const afterDelete = queued!(current)
    expect(liveScalar(row, scope, getGitHubTaskObservation(row), 'state')).toBeUndefined()
    close('upstream')
    const afterSibling = queued!(current)
    console.log('R6 outer scalar replay', JSON.stringify({ before, afterDelete, afterSibling }))
    expect(afterDelete).toEqual(before)
    expect(afterSibling).toEqual(before)
    captureFence.mockClear()
    const foreignRow = { ...seed, repoId: foreignRepo.id, repoHostId: foreignRepo.executionHostId }
    expect(queued!([null, null, [row, foreignRow]])).toEqual(before)
    expect(captureFence).not.toHaveBeenCalled()
    const live = materializeTaskPageItemList({
      networkItems: [row],
      previousItems: [],
      queryKey: 'q',
      context: createTaskPageGitHubProjectionContext(
        [repo],
        parseTaskQuery('is:open'),
        'q',
        'alice'
      )
    })
    expect(live[0].state).toBe('open')
  } finally {
    captureFence.mockRestore()
    read.dispose()
  }
})

it('seals omitted-row membership and pending eligibility while retaining explicit current page values', async () => {
  const { beginGitHubTaskRead } = await import('@/store/github/request-coordination')
  const { deliverTaskPageGitHubRead } =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-pages')
  const { establishTaskPageGitHubMembership, getRegistryMergedTaskPageGitHubWorkItem } =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-composition')
  const registry =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-registry')
  const owner = captureGitHubTaskObservation(repo, source)!
  let row = observeGitHubWorkItem({ ...seed, id: 'issue:5', state: 'closed' }, owner)
  const scope = getTaskSourceCacheScope(source)
  assertTaskPageGitHubDialogStateAuthority({
    repoId: repo.id,
    itemId: row.id,
    sourceContext: source,
    ownerRepo: { owner: 'o', repo: 'r', host: 'github.com' },
    state: 'closed'
  })
  row = getRegistryMergedTaskPageGitHubWorkItem(row, scope, owner)
  establishTaskPageGitHubMembership({
    item: row,
    sourceScope: scope,
    queryKey: 'q',
    skipMeQualifiers: false,
    observation: owner,
    accepted: true
  })
  const pendingRow = observeGitHubWorkItem(
    { ...row, id: 'issue:6', number: 6, url: 'https://github.com/o/r/issues/6', state: 'open' },
    owner
  )
  const { taskPageGitHubMutationItemId } =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-keys')
  const pendingKey = {
    sourceScope: scope,
    observation: owner,
    repoId: repo.id,
    itemId: taskPageGitHubMutationItemId(pendingRow),
    opKey: 'state'
  }
  registry.setPendingTaskPageGitHubOp({
    key: pendingKey,
    generation: 1,
    previous: {},
    next: { state: 'closed' },
    skipMeQualifiers: false,
    startedAt: 1
  })
  type Pages = (GitHubWorkItem[] | null)[]
  const current: Pages = [[row, pendingRow]]
  const read = beginGitHubTaskRead(
    [{ repoId: repo.id, sourceContext: source }],
    undefined,
    store.getState()
  )
  let queued: ((pages: Pages) => Pages) | undefined
  try {
    deliverTaskPageGitHubRead(
      read,
      [],
      (update) => {
        if (typeof update === 'function') {
          queued = update
        }
      },
      { current },
      createTaskPageGitHubProjectionContext([repo], parseTaskQuery('is:open'), 'q', 'alice'),
      (pages, rows, materialize) => [materialize(rows, pages[0] ?? [])]
    )
    const before = queued!(current)
    expect(before[0]?.map((item) => item.id)).toEqual([row.id, pendingRow.id])
    for (const key of registry.getTaskPageGitHubMembershipBases().keys()) {
      registry.deleteTaskPageGitHubMembershipBasis(key)
    }
    registry.deletePendingTaskPageGitHubOp(pendingKey)
    deleteLastConfirmedClientValue(scope, repo.id, row.id, 'state')
    const after = queued!(current)
    console.log('R6 outer omitted replay', JSON.stringify({ before, after }))
    expect(after).toEqual(before)
    const changed = observeGitHubWorkItem(
      {
        ...row,
        title: 'Current Y',
        assignees: [],
        author: 'profile',
        authorAvatarUrl: 'current.png'
      },
      owner,
      true
    )
    const explicit = queued!([[changed]])
    expect(explicit[0]?.[0]).toEqual(changed)
    const profiled = {
      ...changed,
      assignees: [{ login: 'y', name: 'Current profile', avatarUrl: 'y.png' }]
    }
    expect(queued!([[profiled]])[0]?.[0]).toEqual(profiled)
    expect(queued!([[]])).toEqual([[]])
    expect(
      materializeTaskPageItemList({
        networkItems: [],
        previousItems: current[0] ?? [],
        queryKey: 'q',
        context: createTaskPageGitHubProjectionContext(
          [repo],
          parseTaskQuery('is:open'),
          'q',
          'alice'
        )
      })
    ).toEqual([])
  } finally {
    read.dispose()
  }
})
