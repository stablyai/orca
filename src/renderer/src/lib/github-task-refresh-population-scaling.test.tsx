// @vitest-environment happy-dom
import {
  confirmListForTest,
  context,
  store,
  container,
  direct,
  list,
  fixture,
  mount,
  click
} from './github-task-refresh.test-fixture'

import { repo, source, key, user, returned } from './github-task-refresh-data.test-fixture'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import { parseTaskQuery } from '../../../shared/task-query'
import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import { getTaskPageRepoSourceContext } from '@/components/task-page/task-page-source-context'
import { captureGitHubTaskObservation } from './github-task-observation'
import {
  createTaskPageGitHubProjectionContext,
  reapplyPendingTaskPageGitHubMutationsToCache
} from '@/components/task-page/github/task-page-github-work-item-mutation-pages'
import {
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import { taskPageGitHubMutationItemId } from '@/components/task-page/github/task-page-github-work-item-mutation-keys'
import { beginGitHubTaskRead } from '@/store/github/request-coordination'

it('bounds population delivery preparation across cold and published multi-domain Tasks owners', async () => {
  const { observeGitHubWorkItem } = await import('./github-task-observation')
  const cache = await import('@/store/github/work-item-cache-patches')
  const materialization =
    await import('@/components/task-page/github/task-page-github-work-item-materialization')
  const { deliverTaskPageGitHubRead } =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-pages')
  const { useGitHubTaskDeliveryState } = await import('@/hooks/useGitHubTaskDeliveryState')
  const batches = await import('@/store/github/task-read-batches')
  const phases = await import('@/store/github/task-read-reconciliation')
  const { workItemsCacheKey } = await import('@/store/github/cache-identity')
  const measured: object[] = []
  for (const n of [100, 1000]) {
    resetTaskPageGitHubMutationRegistryForTests()
    setTaskPageGitHubMutationQueryKey('q')
    fixture()
    const second = { ...repo, id: 'second', path: '/second' }
    const foreign = {
      ...repo,
      id: 'foreign',
      path: '/foreign',
      executionHostId: 'ssh:foreign' as const
    }
    const repos = [repo, second, foreign]
    const sources = repos.map((r) => getTaskPageRepoSourceContext(r, 'github')!)
    const owners = repos.map((r, i) => captureGitHubTaskObservation(r, sources[i])!)
    const rows = Array.from({ length: n }, (_, i) => {
      const r = i % 2
      return observeGitHubWorkItem(
        {
          ...returned.item,
          id: `issue:${100 + i}`,
          repoId: repos[r].id,
          number: 100 + i,
          url: `https://github.com/o/r/issues/${100 + i}`,
          assignees: [user('alice')]
        },
        owners[r],
        true
      )
    })
    const unrelated = observeGitHubWorkItem(
      {
        ...returned.item,
        repoId: repo.id,
        id: 'issue:9000',
        number: 9000,
        url: 'https://github.com/o/r/issues/9000',
        assignees: [user('untouched')]
      },
      owners[0],
      true
    )
    const foreignRow = observeGitHubWorkItem(
      { ...unrelated, repoId: foreign.id, repoHostId: foreign.executionHostId },
      owners[2],
      true
    )
    store.setState({
      repos,
      workItemsCache: Object.fromEntries(
        repos.map((r, i) => [
          workItemsCacheKey(r.id, 30, '', getTaskSourceCacheScope(sources[i])),
          {
            data:
              i === 2
                ? [foreignRow]
                : [...rows.filter((row) => row.repoId === r.id), ...(i ? [] : [unrelated])],
            fetchedAt: 0
          }
        ])
      )
    })
    for (const row of rows) {
      confirmListForTest(
        getTaskSourceCacheScope(sources[row.repoId === repo.id ? 0 : 1]),
        row.repoId,
        taskPageGitHubMutationItemId(row),
        'assignees',
        [user('bob')],
        owners[row.repoId === repo.id ? 0 : 1]
      )
    }
    const targets = repos
      .slice(0, 2)
      .map((r, i) => ({ repoId: r.id, path: r.path, sourceContext: sources[i] }))
    const cold = beginGitHubTaskRead(targets, undefined, { repos })
    const read = beginGitHubTaskRead(targets, undefined, { repos })
    const isolated = beginGitHubTaskRead(
      [{ repoId: foreign.id, path: foreign.path, sourceContext: sources[2] }],
      undefined,
      { repos }
    )
    const absent = beginGitHubTaskRead(targets, undefined, { repos })
    const independent = beginGitHubTaskRead(targets, undefined, { repos })
    const independentDestination = vi.fn()
    independent.deliver([rows[0]], independentDestination)
    independentDestination.mockClear()
    const controls = [rows[0], rows[1], unrelated, foreignRow]
    const initial = [controls.slice(0, 2), controls.slice(2)]
    const pagesRef = { current: initial }
    let pages: (readonly GitHubWorkItem[] | null)[] = initial
    let setter:
      | React.Dispatch<React.SetStateAction<(readonly GitHubWorkItem[] | null)[]>>
      | undefined
    function Owner() {
      const [value, setValue] =
        useGitHubTaskDeliveryState<(readonly GitHubWorkItem[] | null)[]>(initial)
      React.useLayoutEffect(() => {
        pages = value
        setter = setValue
      })
      return (
        <div data-scaled-owner>
          {value
            .flatMap((p) => p ?? [])
            .map((row) => row.assignees?.map((u) => u.login).join(','))
            .join('|')}
        </div>
      )
    }
    await mount(false, () => <Owner />)
    const projection = createTaskPageGitHubProjectionContext(
      repos,
      parseTaskQuery('is:open'),
      'q',
      'alice'
    )
    read.borrow(controls)
    const queue: (() => void)[] = []
    const absentDestination = vi.fn()
    absent.borrow([unrelated])
    absent.deliver([unrelated], absentDestination)
    absentDestination.mockClear()
    isolated.borrow([foreignRow])
    const foreignDestination = vi.fn()
    isolated.deliver([foreignRow], foreignDestination)
    foreignDestination.mockClear()
    let callbacks = 0,
      materializers = 0,
      loaded = 0,
      copied = 0,
      prepared = 0,
      commits = 0,
      indexes = 0,
      indexed = 0
    const knownPages = new WeakSet<object>([pagesRef.current])
    const assign = (
      current: (readonly GitHubWorkItem[] | null)[],
      next: readonly GitHubWorkItem[]
    ) => {
      const result = [next.slice(0, 2), next.slice(2)]
      knownPages.add(current)
      knownPages.add(result)
      return result
    }
    const destination: typeof setter = (change) => {
      callbacks++
      setter!(change)
    }
    await act(async () =>
      deliverTaskPageGitHubRead(read, controls, destination, pagesRef, projection, assign)
    )
    const held = Promise.withResolvers<{
      items: GitHubWorkItem[]
      sources: { issues: null; prs: null }
    }>()
    list.mockReturnValue(held.promise)
    const transports = [cold, read].map((taskRead) =>
      store
        .getState()
        .fetchWorkItems(repo.id, repo.path, 12, 'scale-held', { sourceContext: source, taskRead })
    )
    const events: string[] = []
    const compile = batches.prepareGitHubTaskReadBatch
    const compiler = vi
      .spyOn(batches, 'prepareGitHubTaskReadBatch')
      .mockImplementation((...args) => {
        indexes++
        const result = compile(...args)
        for (const row of result.rows.values()) {
          for (const group of row.values()) {
            indexed += group.length
          }
        }
        return result
      })
    const markWrites = phases.markGitHubTaskDeliveryWrites,
      markPlans = phases.markGitHubTaskListWrites
    const writePhase = vi
      .spyOn(phases, 'markGitHubTaskDeliveryWrites')
      .mockImplementation((writes) => {
        events.push('writes')
        markWrites(writes)
      })
    const planPhase = vi.spyOn(phases, 'markGitHubTaskListWrites').mockImplementation((plans) => {
      events.push('plans')
      markPlans(plans)
    })
    const preparedWrites = new WeakSet<object>()
    const prepare = cache.prepareWorkItemPatches
    const prepareSpy = vi.spyOn(cache, 'prepareWorkItemPatches').mockImplementation((...args) => {
      const result = prepare(...args)
      prepared += result.deliveryWrites.length
      result.deliveryWrites.forEach((write) => preparedWrites.add(write))
      return result
    })
    const iterator = Array.prototype[Symbol.iterator]
    Array.prototype[Symbol.iterator] = function* (this: unknown[]) {
      for (const value of { [Symbol.iterator]: () => iterator.call(this) }) {
        if (value && typeof value === 'object' && preparedWrites.has(value)) {
          copied++
        }
        yield value
      }
      return undefined
    }
    const flatMap = Array.prototype.flatMap
    const flatten = vi.spyOn(Array.prototype, 'flatMap').mockImplementation(function (
      this: unknown[],
      callback,
      thisArg
    ) {
      if (knownPages.has(this)) {
        loaded += this.reduce((sum: number, p) => sum + (Array.isArray(p) ? p.length : 0), 0)
      }
      return flatMap.call(this, callback, thisArg)
    })
    const materializer = materialization.createTaskPageGitHubMaterializer
    const materializerSpy = vi
      .spyOn(materialization, 'createTaskPageGitHubMaterializer')
      .mockImplementation((...args) => {
        materializers++
        return materializer(...args)
      })
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.workItemsCache !== previous.workItemsCache) {
        commits++
        events.push('cache')
      }
    })
    callbacks = 0
    try {
      await act(async () =>
        reapplyPendingTaskPageGitHubMutationsToCache({
          items: rows,
          patchWorkItems: store.getState().patchWorkItems,
          context: projection
        })
      )
      const counts = {
        n,
        prepared,
        copied,
        callbacks,
        materializers,
        loaded,
        commits,
        indexes,
        indexed
      }
      measured.push(counts)
      console.info('PERF-DELIVERY', JSON.stringify(counts))
      expect(prepared).toBe(n)
      expect(events).toEqual(['cache', 'writes', 'plans'])
      expect(indexes).toBe(2)
      expect(indexed).toBeLessThanOrEqual(2 * n)
      expect
        .soft(copied, 'shared preparation and cold retention reference visits')
        .toBeLessThanOrEqual(20 * n + 100)
      expect
        .soft(callbacks, 'one publication per writes/plans call across both domains')
        .toBeLessThanOrEqual(2)
      expect.soft(materializers).toBeLessThanOrEqual(2)
      expect.soft(loaded).toBeLessThanOrEqual(4 * controls.length * 2)
      expect(commits).toBe(1)
      expect(
        pages
          .flatMap((page) => page ?? [])
          .slice(0, 2)
          .map((row) => row.assignees?.[0].login)
      ).toEqual(['bob', 'bob'])
      expect(pages.flatMap((page) => page ?? [])[2]).toBe(unrelated)
      expect(pages.flatMap((page) => page ?? [])[3]).toBe(foreignRow)
      expect(independentDestination).not.toHaveBeenCalled()
      expect.soft(absentDestination).not.toHaveBeenCalled()
      expect.soft(foreignDestination).not.toHaveBeenCalled()
      await act(async () => {
        held.resolve({
          items: rows.filter((row) => row.repoId === repo.id),
          sources: { issues: null, prs: null }
        })
        await Promise.all(transports)
      })
      cold.deliver(controls, (update) => {
        const a = update(controls)
        expect(update(controls)).toEqual(a)
        if ('commit' in update && typeof update.commit === 'function') {
          const commit = update.commit
          queue.push(() => commit())
        }
      })
      cold.finish()
      queue.forEach((commit) => commit())
      read.finish()
      absent.dispose()
      isolated.dispose()
      independent.dispose()
      const after = callbacks
      store
        .getState()
        .patchWorkItem(rows[0].id, { title: 'after discard' }, repo.id, { sourceContext: source })
      expect(callbacks).toBe(after)
    } finally {
      compiler.mockRestore()
      writePhase.mockRestore()
      planPhase.mockRestore()
      prepareSpy.mockRestore()
      Array.prototype[Symbol.iterator] = iterator
      flatten.mockRestore()
      materializerSpy.mockRestore()
      unsubscribe()
      cold.dispose()
      read.dispose()
      isolated.dispose()
      independent.dispose()
      absent.dispose()
      await act(async () => context.root.unmount())
      context.root = createRoot(container)
    }
  }
  console.info('PERF-DELIVERY-ALL', JSON.stringify(measured))
})

it('retains the eligible intermediate write footprint after restore and useful RETURN, with pure replay and independent fields', async () => {
  const { observeGitHubWorkItem } = await import('./github-task-observation')
  const { markGitHubTaskDeliveryWrites } = await import('@/store/github/task-read-reconciliation')
  const owner = captureGitHubTaskObservation(repo, source)!
  const originalLabels = ['original']
  const original = observeGitHubWorkItem(
    { ...returned.item, repoId: repo.id, title: 'Old', labels: originalLabels },
    owner,
    true
  )
  const middle = { ...original, title: 'Intermediate' }
  const restored = { ...original }
  for (const prepaint of [false, true]) {
    const read = beginGitHubTaskRead(
      [{ repoId: repo.id, sourceContext: source }],
      undefined,
      { repos: [repo] },
      [original]
    )
    read.borrow([original])
    let shown: readonly GitHubWorkItem[] = [original]
    let queued: ((current: readonly GitHubWorkItem[]) => readonly GitHubWorkItem[]) | undefined
    const publish = (update: (current: readonly GitHubWorkItem[]) => readonly GitHubWorkItem[]) => {
      queued = update
      shown = update(shown)
    }
    if (prepaint) {
      read.deliver(shown, publish)
    }
    markGitHubTaskDeliveryWrites([
      { before: original, after: middle, written: ['title'] },
      { before: middle, after: restored, written: ['title'] }
    ])
    const useful = { ...original, title: 'Provider', labels: ['provider profile'] }
    read.deliver([useful], publish)
    expect(shown[0].title).toBe('Old')
    expect(shown[0].labels).toBe(useful.labels)
    const replay = queued!
    const input = [original]
    const expected = replay(input)
    read.dispose()
    expect(replay(input)).toEqual(expected)
    expect(replay([{ ...original, title: 'Later ordinary Y' }])[0].title).toBe('Later ordinary Y')
    expect(original.labels).toBe(originalLabels)
  }
})

it('routes one registered manual FULL DIRECT through duplicate buckets inside capacity without search or foreign writes', async () => {
  const { seed } = await import('./github-task-refresh-data.test-fixture')
  const { useItem } = await import('./github-task-refresh.test-fixture')
  const { workItemsCacheKey } = await import('@/store/github/cache-identity')
  const { observeGitHubWorkItem } = await import('./github-task-observation')
  const owner = captureGitHubTaskObservation(repo, source)!
  const row = observeGitHubWorkItem({ ...seed, id: 'issue:5' }, owner, true)
  const scope = getTaskSourceCacheScope(source)
  const duplicates = Array.from({ length: 4 }, (_, i) =>
    workItemsCacheKey(repo.id, 30, `dup-${i}`, scope)
  )
  const foreignSource = { ...source, projectId: 'foreign-account' }
  const foreignKey = workItemsCacheKey(
    repo.id,
    30,
    'foreign',
    getTaskSourceCacheScope(foreignSource)
  )
  const foreign = { data: [row], fetchedAt: 1 }
  const unrelated = Array.from(
    { length: 400 },
    (_, i) =>
      [
        workItemsCacheKey(repo.id, 30, `other-${i}`, scope),
        {
          data: [
            {
              ...row,
              id: `issue:${i + 100}`,
              number: i + 100,
              url: `https://github.com/o/r/issues/${i + 100}`
            }
          ],
          fetchedAt: 1
        }
      ] as const
  )
  store.setState({
    workItemsCache: {
      [key]: { data: [row], fetchedAt: 1 },
      ...Object.fromEntries(duplicates.map((key) => [key, { data: [row], fetchedAt: 1 }])),
      ...Object.fromEntries(unrelated),
      [foreignKey]: foreign
    }
  })
  await mount()
  list.mockClear()
  const calls = direct.mock.calls.length
  direct.mockResolvedValue(returned)
  await click()
  expect(direct).toHaveBeenCalledTimes(calls + 1)
  expect(list).not.toHaveBeenCalled()
  expect(direct.mock.calls.at(-1)?.[0]).toMatchObject({
    repoId: repo.id,
    sourceContext: source,
    ownerRepo: { owner: 'o', repo: 'r', host: 'github.com' }
  })
  expect(container.querySelector('h1')?.textContent).toContain('Accepted title')
  for (const bucket of [key, ...duplicates]) {
    expect(store.getState().workItemsCache[bucket].data?.[0].title).toBe('Accepted title')
  }
  for (const [bucket, entry] of unrelated) {
    expect(store.getState().workItemsCache[bucket]).toBe(entry)
  }
  expect(store.getState().workItemsCache[foreignKey]).toBe(foreign)
  await click('Start workspace from issue')
  expect(useItem).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: 'Accepted title', assignees: returned.item.assignees })
  )
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Refresh task"]')?.disabled).toBe(
    false
  )
  expect(Object.keys(store.getState().workItemsCache)).toHaveLength(406)
})
