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

// @vitest-environment happy-dom

import {
  createTaskPageGitHubProjectionContext,
  materializeTaskPageItemList,
  reapplyPendingTaskPageGitHubMutationsToCache
} from '@/components/task-page/github/task-page-github-work-item-mutation-pages'

import { getLastConfirmedClientEntries } from '@/components/task-page/github/task-page-github-confirmed-client-values'

import { parseTaskQuery } from '../../../shared/task-query'

import { createTaskPageGitHubMembershipProjection } from '@/components/task-page/github/task-page-github-work-item-mutation-composition'

import { runTaskPageGitHubQuietRefresh } from '@/components/task-page/github/task-page-github-quiet-refresh-run'

import { captureGitHubTaskObservation } from './github-task-observation'

import { repo, source, key, user, returned } from './github-task-refresh-data.test-fixture'

import React, { act } from 'react'

import { createRoot } from 'react-dom/client'

import { expect, it, vi } from 'vitest'

import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

import { getTaskPageRepoSourceContext } from '@/components/task-page/task-page-source-context'

import { getTaskSourceCacheScope } from '../../../shared/task-source-context'

import {
  setPendingTaskPageGitHubOp,
  setLastConfirmedClientValue,
  getTaskPageGitHubPendingEntries,
  getTaskPageGitHubListEntries,
  getListEntry,
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import { workItemDetailsCache } from '@/components/github-item-dialog/load-item-details/work-item-details-cache'

import { taskPageGitHubMutationItemId } from '@/components/task-page/github/task-page-github-work-item-mutation-keys'

import { beginGitHubTaskRead } from '@/store/github/request-coordination'

it('bounds actual acceptance, owned row projection/admission and final completion as rows, owners, authority and reads vary independently', async () => {
  const measured: {
    n: number
    s: number
    h: number
    r: number
    acceptance: number[]
    admission: number[]
    completion: number[]
  }[] = []
  for (const [n, s, h, r] of [
    [100, 1, 1, 1],
    [1000, 1, 1, 1],
    [100, 100, 1, 1],
    [100, 1000, 1, 1],
    [100, 1, 100, 1],
    [100, 1, 1000, 1],
    [100, 1, 1, 100],
    [100, 1, 1, 1000]
  ]) {
    resetTaskPageGitHubMutationRegistryForTests()
    setTaskPageGitHubMutationQueryKey('q')
    fixture(n)
    const repos = Array.from({ length: s }, (_, i) =>
      i
        ? {
            ...repo,
            id: `owner-${i}`,
            path: `/owner-${i}`,
            executionHostId: `ssh:host-${i}` as const,
            connectionId: `host-${i}`
          }
        : { ...repo }
    )
    const sources = repos.map((owner) => getTaskPageRepoSourceContext(owner, 'github')!)
    store.setState({ repos })
    const rows = store.getState().workItemsCache[key].data!
    rows.forEach((row, i) => {
      if (i > 1) {
        row.repoId = repos[i % s].id
        row.repoHostId = repos[i % s].executionHostId
      }
    })
    context.pages = [null, null, rows]
    const observation = captureGitHubTaskObservation(repos[0], sources[0])
    for (let i = 0; i < h; i++) {
      const itemId = `issue:${i + n + 20}`
      const pendingKey = {
        sourceScope: getTaskSourceCacheScope(sources[0]),
        repoId: repo.id,
        itemId,
        itemType: 'issue' as const,
        observation,
        opKey: 'state'
      }
      setPendingTaskPageGitHubOp({
        key: pendingKey,
        generation: 1,
        previous: { state: 'open' },
        next: { state: 'closed' },
        startedAt: i,
        skipMeQualifiers: false
      })
      confirmListForTest(
        pendingKey.sourceScope,
        repo.id,
        itemId,
        'assignees',
        [user('unrelated')],
        observation
      )
      setLastConfirmedClientValue(
        pendingKey.sourceScope,
        repo.id,
        itemId,
        'state',
        'closed',
        undefined,
        observation
      )
    }
    await mount()
    let rowVisits = 0,
      repoVisits = 0,
      authorityVisits = 0,
      marks = 0,
      notifications = 0
    for (const row of rows) {
      const url = row.url
      Object.defineProperty(row, 'url', {
        configurable: true,
        enumerable: true,
        get: () => {
          rowVisits++
          return url
        }
      })
    }
    for (const owner of repos) {
      const path = owner.path
      Object.defineProperty(owner, 'path', {
        configurable: true,
        enumerable: true,
        get: () => {
          repoVisits++
          return path
        }
      })
    }
    const spies = [
      getTaskPageGitHubPendingEntries(),
      getTaskPageGitHubListEntries(),
      getLastConfirmedClientEntries()
    ].map((entries) => {
      const original = entries.values.bind(entries)
      return vi.spyOn(entries, 'values').mockImplementation(function* () {
        for (const entry of original()) {
          authorityVisits++
          yield entry
        }
      })
    })
    const reads = Array.from({ length: r }, () =>
      beginGitHubTaskRead([{ repoId: repo.id, sourceContext: source }], undefined, { repos })
    )
    reads.forEach((read) => {
      const original = read.mark
      vi.spyOn(read, 'mark').mockImplementation((...args) => {
        marks++
        original(...args)
      })
    })
    const unsubscribe = store.subscribe(() => {
      notifications++
    })
    const reset = () => {
      rowVisits = repoVisits = authorityVisits = 0
    }
    const counts = () => [rowVisits, repoVisits, authorityVisits]
    reset()
    const calls = direct.mock.calls.length
    direct.mockResolvedValue(returned)
    await click()
    const acceptance = counts()
    expect(direct.mock.calls.length - calls).toBe(1)
    expect(list).not.toHaveBeenCalled()
    expect(marks).toBe(r)
    expect(notifications).toBeLessThanOrEqual(4)
    expect(acceptance[0]).toBeLessThanOrEqual(20 * (n + 2) + 100)
    expect(acceptance[1]).toBeLessThanOrEqual(20 * s + 100)
    expect(acceptance[2]).toBeLessThanOrEqual(40 * h + 100)
    reset()
    const projectionContext = createTaskPageGitHubProjectionContext(
      repos,
      parseTaskQuery('is:open'),
      'q',
      'alice'
    )
    const admitted = materializeTaskPageItemList({
      networkItems: rows,
      previousItems: context.pages[2]!,
      queryKey: 'q',
      context: projectionContext
    })
    const project = createTaskPageGitHubMembershipProjection(projectionContext)
    const visible = admitted.filter((row) => {
      const owner = projectionContext.ownerOf!(row)
      return !project(row, owner ? getTaskSourceCacheScope(owner.source) : null, owner).hide
    })
    expect(visible).toHaveLength(rows.length)
    expect(visible.at(-1)?.title).toBe(rows.at(-1)?.title)
    const admission = counts()
    expect(admission[0]).toBeLessThanOrEqual(20 * (n + 2) + 100)
    expect(admission[1]).toBeLessThanOrEqual(20 * s + 100)
    expect(admission[2]).toBeLessThanOrEqual(30 * h + 100)
    reset()
    const result = reads[0].apply(rows, store.getState().workItemsCache[key].data!)
    expect(result[0].title).toBe('Accepted title')
    expect(result[1]).toBe(rows[1])
    expect(result.at(-1)).toBe(rows.at(-1))
    const completion = counts()
    expect(completion[0]).toBeLessThanOrEqual(4 * (n + 2) + 20)
    expect(completion[1]).toBeLessThanOrEqual(20)
    expect(completion[2]).toBe(0)
    measured.push({ n, s, h, r, acceptance, admission, completion })
    unsubscribe()
    spies.forEach((spy) => spy.mockRestore())
    reads.forEach((read) => read.dispose())
    await act(async () => context.root.unmount())
    context.root = createRoot(container)
    workItemDetailsCache.clear()
  }
  for (const phase of ['acceptance', 'admission', 'completion'] as const) {
    expect(measured[1][phase][0]).toBeLessThanOrEqual(measured[0][phase][0] * 10 + 100)
    expect(measured[3][phase][1]).toBeLessThanOrEqual(measured[2][phase][1] * 10 + 100)
    expect(measured[5][phase][2]).toBeLessThanOrEqual(measured[4][phase][2] * 10 + 100)
    expect(measured[7][phase]).toEqual(measured[6][phase])
  }
  console.log(
    'Refresh operation counts (row, registered-owner, authority visits)',
    JSON.stringify(measured)
  )
})
it('bounds real ordinary cache reapplication after accepted publication when applicable list authority grows with cached rows', async () => {
  const measured: {
    n: number
    visits: number
    writes: number
    scans: number
    quietWrites: number
    quietScans: number
    s: number
    ownerReads: number
    p: number
    r: number
    retiredReads: number
    pendingVisits: number
    l: number
    loginReads: number
  }[] = []
  for (const [n, s, p, r, l] of [
    [100, 1, 1, 1, 1],
    [1000, 1, 1, 1, 1],
    [100, 1000, 1, 1, 1],
    [100, 1, 1000, 1, 1],
    [100, 1, 1, 1000, 1],
    [100, 1, 1, 1, 100],
    [100, 1, 1, 1, 1000]
  ]) {
    resetTaskPageGitHubMutationRegistryForTests()
    setTaskPageGitHubMutationQueryKey('q')
    fixture(n)
    const repos = [
      repo,
      ...Array.from({ length: s - 1 }, (_, i) => ({
        ...repo,
        id: `other-owner-${i}`,
        path: `/other-owner-${i}`
      }))
    ]
    store.setState({ repos })
    const rows = store.getState().workItemsCache[key].data!
    const observation = captureGitHubTaskObservation(repo, source)
    const last = rows.at(-1)!
    const profiles = Array.from({ length: l }, (_, i) => user(i ? `member-${i}` : 'bob'))
    for (const row of rows.slice(2)) {
      confirmListForTest(
        getTaskSourceCacheScope(source),
        repo.id,
        taskPageGitHubMutationItemId(row),
        'assignees',
        row === last ? profiles : [user('bob')],
        observation
      )
    }
    await mount()
    direct.mockResolvedValue(returned)
    await click()
    for (let i = 0; i < p; i++) {
      setPendingTaskPageGitHubOp({
        key: {
          repoId: repo.id,
          itemId: `unrelated-${i}`,
          itemType: 'issue',
          sourceScope: getTaskSourceCacheScope(source),
          observation,
          opKey: 'state'
        },
        generation: 1,
        previous: { state: 'open' },
        next: { state: 'closed' },
        startedAt: i,
        skipMeQualifiers: false
      })
    }
    let loginReads = 0
    const lastEntry = getListEntry({
      repoId: repo.id,
      itemId: taskPageGitHubMutationItemId(last),
      itemType: 'issue',
      sourceScope: getTaskSourceCacheScope(source),
      observation,
      family: 'assignees'
    })!
    const counted = new Set([
      ...profiles,
      ...lastEntry.base.users,
      ...(lastEntry.protection.kind === 'whole' ? lastEntry.protection.expectedUsers : [])
    ])
    for (const profile of counted) {
      const login = profile.login
      Object.defineProperty(profile, 'login', {
        enumerable: true,
        configurable: true,
        get: () => {
          loginReads++
          return login
        }
      })
    }
    let retiredReads = 0,
      pendingVisits = 0
    const pendingEntries = getTaskPageGitHubPendingEntries()
    const pendingValues = pendingEntries.values.bind(pendingEntries)
    const pendingScan = vi.spyOn(pendingEntries, 'values').mockImplementation(function* () {
      for (const entry of pendingValues()) {
        pendingVisits++
        yield entry
      }
    })
    const reads = Array.from({ length: r }, () =>
      beginGitHubTaskRead([{ repoId: repo.id, sourceContext: source }], undefined, { repos })
    )
    const readSpies = reads.map((read) => {
      const retire = read.retire
      return vi.spyOn(read, 'retire').mockImplementation((index, projection) => {
        retiredReads++
        retire(index, projection)
      })
    })
    let visits = 0,
      writes = 0,
      scans = 0,
      ownerReads = 0
    for (const owner of repos) {
      const path = owner.path
      Object.defineProperty(owner, 'path', {
        configurable: true,
        enumerable: true,
        get: () => {
          ownerReads++
          return path
        }
      })
    }
    for (const row of rows) {
      const id = row.id
      Object.defineProperty(row, 'id', {
        configurable: true,
        enumerable: true,
        get: () => {
          visits++
          return id
        }
      })
    }
    const unsubscribe = store.subscribe(() => {
      writes++
    })
    const original = Array.prototype.forEach
    const scan = vi.spyOn(Array.prototype, 'forEach').mockImplementation(function (
      this: unknown[],
      callback,
      thisArg
    ) {
      return original.call(this, (row, index, array) => {
        if (row?.repoId === repo.id && row?.url) {
          scans++
        }
        callback.call(thisArg, row, index, array)
      })
    })
    await act(async () =>
      reapplyPendingTaskPageGitHubMutationsToCache({
        items: rows,
        context: createTaskPageGitHubProjectionContext(
          repos,
          parseTaskQuery('is:open'),
          'q',
          'alice'
        ),
        patchWorkItems: store.getState().patchWorkItems
      })
    )
    const reapplyWrites = writes,
      reapplyScans = scans
    writes = 0
    scans = 0
    const searchBeforeQuiet = list.mock.calls.length
    const networkItems = rows.map((row) => ({
      ...row,
      assignees: row === last ? profiles : [user('bob')]
    }))
    list.mockResolvedValue({
      items: networkItems,
      sources: { issues: { owner: 'o', repo: 'r' }, prs: null }
    })
    const pagesRef = { current: [null, null, rows] as (GitHubWorkItem[] | null)[] }
    const mounted = { current: true }
    const phase: { scans: number; writes: number }[] = []
    const originalBatch = store.getState().patchWorkItems
    const batch = vi.spyOn(store.getState(), 'patchWorkItems').mockImplementation((patches) => {
      const beforeScans = scans,
        beforeWrites = writes
      originalBatch(patches)
      phase.push({ scans: scans - beforeScans, writes: writes - beforeWrites })
    })
    const noop = () => {}
    let cleanup: (() => void) | undefined
    const committed = Promise.withResolvers<void>()
    await act(async () => {
      cleanup = runTaskPageGitHubQuietRefresh({
        ...store.getState(),
        selectedRepos: [repo],
        taskSource: 'github',
        githubMode: 'items',
        appliedTaskSearch: 'is:open',
        appliedTaskQuery: parseTaskQuery('is:open'),
        githubViewerLogin: 'alice',
        githubWorkItemMutationQueryKey: 'q',
        selectedReposKey: 'registered',
        quietRefreshNonce: 1,
        setQuietRefreshNonce: noop,
        githubPerRepoPageLimit: n + 1,
        githubPageSize: n + 1,
        pages: pagesRef.current,
        pagesRef,
        currentPage: 2,
        currentPageRef: { current: 2 },
        setPages: (change) => {
          pagesRef.current = typeof change === 'function' ? change(pagesRef.current) : change
          committed.resolve()
        },
        hardRefreshEpochRef: { current: 0 },
        quietRevalidateMountedRef: mounted,
        quietRevalidateOwnerRef: { current: {} },
        quietRevalidateScopeRef: { current: { queryKey: 'qregistered', generation: 1 } }
      } as Parameters<typeof runTaskPageGitHubQuietRefresh>[0]) // SAFETY: actual quiet owner, transport, population actions and final setter.
      await committed.promise
    })
    cleanup?.()
    mounted.current = false
    batch.mockRestore()
    readSpies.forEach((spy) => spy.mockRestore())
    reads.forEach((read) => read.dispose())
    pendingScan.mockRestore()
    expect(retiredReads, 'one shared retirement program per already-live read').toBe(r)
    expect(
      pendingVisits,
      'pending index is built per pass, never per cache row'
    ).toBeLessThanOrEqual(40 * p + 100)
    scan.mockRestore()
    unsubscribe()
    expect(list.mock.calls.length - searchBeforeQuiet).toBe(1)
    expect(phase).toHaveLength(2)
    expect(phase.every((pass) => pass.writes <= 1 && pass.scans <= n + 1)).toBe(true)
    const quietWrites = writes,
      quietScans = scans
    expect(getTaskPageGitHubListEntries().size).toBe(0)
    const cached = store.getState().workItemsCache[key].data!
    expect(cached[0].title).toBe('Accepted title')
    expect(cached.at(-1)?.assignees).toEqual(profiles)
    expect(loginReads, 'matched list work is linear in real user inputs').toBeLessThanOrEqual(
      60 * l + 100
    )
    measured.push({
      n,
      s,
      ownerReads,
      p,
      r,
      retiredReads,
      pendingVisits,
      l,
      loginReads,
      visits,
      writes: reapplyWrites,
      scans: reapplyScans,
      quietWrites,
      quietScans
    })
    await act(async () => context.root.unmount())
    context.root = createRoot(container)
    workItemDetailsCache.clear()
  }
  console.log('Cache reapplication operations', JSON.stringify(measured))
  for (const { n, s, ownerReads, scans, writes, quietScans, quietWrites } of measured) {
    expect(scans, `actual cache callback visits for ${n} applicable rows`).toBeLessThanOrEqual(
      30 * n + 100
    )
    expect(ownerReads, 'one owner pass, independent of rows').toBeLessThanOrEqual(20 * s + 100)
    expect(writes, 'one reapply transaction').toBeLessThanOrEqual(1)
    expect(quietScans, 'one quiet adoption traversal').toBeLessThanOrEqual(30 * n + 100)
    expect(quietWrites, 'two ordered quiet transactions').toBeLessThanOrEqual(2)
  }
})

it('bounds the actual query-transition collector and unchanged sink independently by rows, retired plans and registered owners', async () => {
  const { transitionTaskPageGitHubMutationQuery } =
    await import('@/components/task-page/github/task-page-github-work-item-query-transition')
  const { createTaskPageGitHubAuthorityProjection } =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-composition')
  const { subscribeTaskPageGitHubMutationRegistry } =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-registry')
  const { observeGitHubWorkItem, gitHubTaskFamilyOrigin } =
    await import('./github-task-observation')
  const selectors = await import('@/store/github/work-item-patch-selectors')
  const measured: object[] = []
  for (const [n, p, s] of [
    [100, 10, 1],
    [1000, 10, 1],
    [1000, 100, 1],
    [1000, 1000, 1],
    [100, 10, 100],
    [100, 10, 1000]
  ]) {
    resetTaskPageGitHubMutationRegistryForTests()
    setTaskPageGitHubMutationQueryKey('before')
    fixture()
    const repos = [
      repo,
      ...Array.from({ length: s - 1 }, (_, i) => ({
        ...repo,
        id: `unrelated-${i}`,
        path: `/unrelated-${i}`
      }))
    ]
    store.setState({ repos })
    const observation = captureGitHubTaskObservation(repo, source)!
    const scope = getTaskSourceCacheScope(source)
    const plain = Array.from({ length: n }, (_, i): GitHubWorkItem => ({
      ...returned.item,
      id: `issue:${i + 100}`,
      number: i + 100,
      repoId: repo.id,
      url: `https://github.com/o/r/issues/${i + 100}`,
      assignees: [user('bob')]
    }))
    for (const row of [
      ...plain.slice(0, p),
      {
        ...plain[0],
        number: n + 100,
        url: `https://github.com/o/r/issues/${n + 100}`,
        id: `issue:${n + 100}`
      }
    ]) {
      confirmListForTest(
        scope,
        repo.id,
        taskPageGitHubMutationItemId(row),
        'assignees',
        [user('bob')],
        observation
      )
    }
    const project = createTaskPageGitHubAuthorityProjection()
    const rows = plain.map((row) =>
      project(observeGitHubWorkItem(row, observation, true), scope, observation)
    )
    store.setState({ workItemsCache: { [key]: { data: rows, fetchedAt: 19 } } })
    let phase = 'collector',
      familyProbes = 0,
      tokenProbes = 0,
      ownerProbes = 0,
      entryVisits = 0,
      traversals = 0,
      rowVisits = 0,
      sinkRows = 0,
      commits = 0
    for (const owner of repos) {
      const path = owner.path
      Object.defineProperty(owner, 'path', {
        configurable: true,
        enumerable: true,
        get: () => {
          ownerProbes++
          return path
        }
      })
    }
    const measuredOrigins = new Set<object>()
    for (const row of rows) {
      const origins = row.githubValueOrigins
      if (!origins) {
        throw new Error('Expected production-issued provenance')
      }
      for (const family of ['assignees', 'reviewRequests'] as const) {
        const origin = origins[family]
        Object.defineProperty(origins, family, {
          configurable: true,
          enumerable: true,
          get: () => {
            if (phase === 'collector') {
              familyProbes++
            }
            return origin
          }
        })
        if (origin?.listLifetime && !measuredOrigins.has(origin)) {
          measuredOrigins.add(origin)
          const token = origin.listLifetime
          Object.defineProperty(origin, 'listLifetime', {
            configurable: true,
            enumerable: true,
            get: () => {
              if (phase === 'collector') {
                tokenProbes++
              }
              return token
            }
          })
        }
      }
    }
    const entries = getTaskPageGitHubListEntries()
    const values = entries.values.bind(entries)
    const population = vi.spyOn(entries, 'values').mockImplementation(function* () {
      for (const entry of values()) {
        entryVisits++
        yield entry
      }
    })
    const iterator = rows[Symbol.iterator].bind(rows)
    const traversal = vi.spyOn(rows, Symbol.iterator).mockImplementation(function* () {
      if (phase === 'collector') {
        traversals++
      }
      for (const row of iterator()) {
        if (phase === 'collector') {
          rowVisits++
        }
        yield row
      }
    })
    const forEach = rows.forEach.bind(rows)
    const callbacks = vi.spyOn(rows, 'forEach').mockImplementation((callback, thisArg) =>
      forEach((row, index, array) => {
        sinkRows++
        callback.call(thisArg, row, index, array)
      })
    )
    const candidates = vi.spyOn(selectors, 'rowMatchesPatch')
    const events: string[] = []
    const offStore = store.subscribe(() => {
      commits++
      events.push('cache')
    })
    const read = beginGitHubTaskRead(
      [{ repoId: repo.id, path: repo.path, sourceContext: source }],
      undefined,
      store.getState()
    )
    const retire = read.retire.bind(read)
    const handoff = vi.spyOn(read, 'retire').mockImplementation((program, projection) => {
      events.push('read')
      retire(program, projection)
    })
    const offRegistry = subscribeTaskPageGitHubMutationRegistry(() => {
      events.push('registry')
      expect(getTaskPageGitHubListEntries().size).toBe(0)
      const data = store.getState().workItemsCache[key].data!
      expect(
        data.slice(0, p).every((row) => !gitHubTaskFamilyOrigin(row, 'assignees')?.listLifetime)
      ).toBe(true)
    })
    const realPatch = store.getState().patchWorkItems
    const patch = vi.spyOn(store.getState(), 'patchWorkItems').mockImplementation((requests) => {
      phase = 'sink'
      realPatch(requests)
      phase = 'after'
    })
    transitionTaskPageGitHubMutationQuery('after', store.getState())
    const emissions = patch.mock.calls[0][0].length
    const candidateWork = candidates.mock.calls.length
    const data = store.getState().workItemsCache[key].data!
    const count = {
      n,
      p,
      s,
      familyProbes,
      tokenProbes,
      ownerProbes,
      entryVisits,
      traversals,
      rowVisits,
      emissions,
      sinkRows,
      candidateWork,
      commits,
      events: [...events]
    }
    measured.push(count)
    expect(emissions).toBe(p)
    expect(traversals).toBe(2)
    expect(rowVisits).toBe(2 * n)
    expect(familyProbes).toBeLessThanOrEqual(4 * n + 2 * p)
    expect(tokenProbes).toBe(p)
    expect(entryVisits).toBeLessThanOrEqual(8 * (p + 1))
    expect(ownerProbes).toBeLessThanOrEqual(20 * s + 100)
    expect(sinkRows).toBe(n)
    expect(candidateWork).toBe(p)
    expect(commits).toBe(1)
    expect(events).toEqual(['cache', 'read', 'registry'])
    expect(data.slice(0, p).map((row) => row.url)).toEqual(plain.slice(0, p).map((row) => row.url))
    expect(data.slice(0, p).every((row) => row.assignees?.[0]?.login === 'bob')).toBe(true)
    expect(data.slice(p).every((row, i) => row === rows[p + i])).toBe(true)
    const snapshot = store.getState().workItemsCache
    commits = 0
    events.length = 0
    transitionTaskPageGitHubMutationQuery('empty', store.getState())
    expect(commits).toBe(0)
    expect(store.getState().workItemsCache).toBe(snapshot)
    expect(patch).toHaveBeenCalledTimes(1)
    offRegistry()
    offStore()
    read.dispose()
    patch.mockRestore()
    handoff.mockRestore()
    candidates.mockRestore()
    callbacks.mockRestore()
    traversal.mockRestore()
    population.mockRestore()
  }
  console.info('Actual query transition operations', JSON.stringify(measured))
})
