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

import type { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'

import { getTaskPageRepoSourceContext } from '@/lib/task-repo-source-context'

import { getGitHubTaskObservation } from './github-task-observation'

import { gitHubTaskFamilyOrigin } from './github-task-observation'

import { createTaskPageGitHubProjectionContext } from '@/components/task-page/github/task-page-github-work-item-mutation-pages'

import { reconcileTaskPagePagesWithWorkItemsCache } from '@/components/task-page/task-page-cache-selectors'

import { VisibleReaders } from './github-task-refresh-visible-readers.test-fixture'

it.each(
  [false, true].flatMap((bobSucceeds) =>
    [false, true].map((bobFirst) => ({ bobSucceeds, bobFirst }))
  )
)(
  'settles overlapping Bob removal and Cora addition from a foreign-account display without losing independent facts (Bob success=$bobSucceeds, first=$bobFirst)',
  async ({ bobSucceeds, bobFirst }) => {
    const query = 'is:open assignee:@me'
    const sources = { issues: { owner: 'o', repo: 'r' }, prs: null }
    window.api.gh.viewer = vi.fn().mockResolvedValue({ login: 'bob' })
    list.mockResolvedValueOnce({
      items: [{ ...seed, assignees: [user('alice'), user('bob')] }],
      sources
    })
    const rows = await store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: source })
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
        query={query}
      />
    )
    await mount(false, outputs, query, true)
    await act(async () => {
      await store
        .getState()
        .updateRepo(
          repo.id,
          { ghAccount: { host: 'github.com', user: 'bob' } },
          { hostId: 'local' }
        )
    })
    const openingReads = direct.mock.calls.length
    const bob = Promise.withResolvers<{ ok: boolean }>()
    const cora = Promise.withResolvers<{ ok: boolean }>()
    let bobWrite: Promise<unknown>, coraWrite: Promise<unknown>
    await act(async () => {
      bobWrite = taskMutation.run({
        item: context.pages[2]![0],
        sourceContext: source,
        intent: { type: 'toggleAssignee', user: user('bob') },
        mutate: () => bob.promise,
        errorToast: 'Rejected'
      })
      coraWrite = taskMutation.run({
        item: context.pages[2]![0],
        sourceContext: source,
        intent: { type: 'toggleAssignee', user: user('cora') },
        mutate: () => cora.promise,
        errorToast: 'Rejected'
      })
    })
    const settleBob = async () => {
      bob.resolve({ ok: bobSucceeds })
      await bobWrite!
    }
    const settleCora = async () => {
      cora.resolve({ ok: !bobSucceeds })
      await coraWrite!
    }
    await act(async () => {
      await (bobFirst ? settleBob() : settleCora())
    })
    expect(context.pages[2]![0].assignees?.map((user) => user.login)).toContain(
      bobFirst ? 'cora' : 'alice'
    )
    await act(async () => {
      await (bobFirst ? settleCora() : settleBob())
    })
    const expected = bobSucceeds ? ['alice'] : ['alice', 'bob', 'cora']
    expect(context.pages[2]![0].assignees?.map((user) => user.login)).toEqual(expected)
    const cacheKey = Object.keys(store.getState().workItemsCache).find((key) =>
      key.endsWith(query)
    )!
    const cache = store.getState().workItemsCache[cacheKey]
    expect(cache.data![0].assignees?.map((user) => user.login)).toEqual(expected)
    expect(cache.fullFetchObservation).toBe(getGitHubTaskObservation(rows[0]))
    const visible = [...container.querySelectorAll('[data-tasks] h3')].map(
      (node) => node.textContent
    )
    expect(visible).toEqual(bobSucceeds ? [] : [seed.title])
    const avatars = [...container.querySelectorAll('[data-tasks] img')].map((img) =>
      img.getAttribute('title')
    )
    expect(avatars.includes('cora (cora)')).toBe(!bobSucceeds)
    expect(getGitHubTaskObservation(rows[0])?.binding).toContain('alice')
    expect(store.getState().workItemsCache[initialCacheKey].data![1]).toBe(foreign)
    expect(JSON.stringify(foreign)).toBe(foreignData)
    expect(list).toHaveBeenCalledTimes(1)
    expect(direct).toHaveBeenCalledTimes(openingReads)
  }
)

it.each([false, true])(
  'restores both canonical pending destinations through cache reentry (upstream cache first=%s)',
  async (upstreamFirst) => {
    const { getTaskPageGitHubListEntries, getTaskPageGitHubPendingEntries } =
      await import('@/components/task-page/github/task-page-github-work-item-mutation-registry')
    const { admitTaskPageGitHubListInputs, overlayPendingOnTaskPagePages } =
      await import('@/components/task-page/github/task-page-github-work-item-mutation-pages')
    const forkQuery = 'is:open'
    const upstreamQuery = 'is:open assignee:alice'
    const ordinary = (owner: string): GitHubWorkItem => ({
      ...seed,
      id: 'issue:5',
      url: `https://github.com/${owner}/r/issues/5`,
      title: `${owner} pending destination`,
      assignees: [user('alice')]
    })
    const fork = ordinary('fork'),
      upstream = ordinary('upstream')
    const neighbor = {
      ...fork,
      id: 'issue:6',
      number: 6,
      url: 'https://github.com/fork/r/issues/6',
      title: 'Untouched neighbor'
    }
    const fetch = async (owner: string, query: string, force = false) => {
      list.mockResolvedValueOnce({
        items: owner === 'fork' ? [fork, neighbor] : [upstream],
        sources: { issues: { owner, repo: 'r' }, prs: null }
      })
      return store
        .getState()
        .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: source, force })
    }
    if (upstreamFirst) {
      await fetch('upstream', upstreamQuery)
    }
    const forkRows = await fetch('fork', forkQuery)
    const keyFor = (query: string) =>
      Object.keys(store.getState().workItemsCache).find((key) => key.endsWith(query))!
    const forkKey = keyFor(forkQuery)
    const foreign = store.getState().workItemsCache[initialCacheKey].data![0]
    const foreignData = JSON.stringify(foreign),
      neighborData = JSON.stringify(forkRows[1])
    const owner = getGitHubTaskObservation(forkRows[0])!
    context.pages = [null, null, forkRows]
    let activeQuery = forkQuery
    const outputs = (
      pages: (GitHubWorkItem[] | null)[],
      mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>,
      queryKey: string,
      viewerLogin: string | null
    ) => (
      <>
        {[0, 2].map((page) => (
          <section key={page} data-retained-page={page}>
            <VisibleReaders
              pages={[null, null, pages[page] ?? null]}
              mutation={mutation}
              queryKey={queryKey}
              viewerLogin={viewerLogin}
              query={activeQuery}
              kind="issues"
            />
          </section>
        ))}
      </>
    )
    await mount(false, outputs, activeQuery, true)
    const directReads = direct.mock.calls.length
    const tokens = new Map<object, number>()
    const tokenId = (
      token?: NonNullable<ReturnType<typeof gitHubTaskFamilyOrigin>>['listLifetime']
    ) => {
      if (!token) {
        return null
      }
      if (!tokens.has(token)) {
        tokens.set(token, tokens.size + 1)
      }
      return tokens.get(token)
    }
    const describe = (row: GitHubWorkItem) => {
      const origin = gitHubTaskFamilyOrigin(row, 'assignees')
      return {
        url: row.url,
        id: row.id,
        users: row.assignees?.map((u) => u.login),
        owner: getGitHubTaskObservation(row)?.key,
        origin: origin?.kind,
        lifetime: tokenId(origin?.listLifetime),
        completeFamily: origin?.completeFamily
      }
    }
    const snapshot = (stage: string) => {
      console.info(
        'R5-ADDRESS',
        JSON.stringify({
          upstreamFirst,
          stage,
          caches: Object.entries(store.getState().workItemsCache).map(([key, entry]) => ({
            key,
            owner: entry.fullFetchObservation?.key,
            rows: entry.data?.map(describe)
          })),
          pages: context.pages.map((page) => page?.map(describe) ?? null),
          entries: [...getTaskPageGitHubListEntries().values()].map((entry) => ({
            itemId: entry.itemId,
            lifetime: tokenId(entry.lifetime),
            base: entry.base.kind,
            users: entry.base.users.map((u) => u.login),
            protection: entry.protection.kind
          })),
          pending: [...getTaskPageGitHubPendingEntries().values()].map((op) => ({
            itemId: op.key.itemId,
            generation: op.generation,
            listOp: op.listOp
          })),
          visible: [...container.querySelectorAll('[data-tasks] h3')].map((n) => n.textContent),
          avatars: [...container.querySelectorAll('[data-tasks] img')].map((n) =>
            n.getAttribute('title')
          ),
          listCalls: list.mock.calls,
          updateCalls: update.mock.calls
        })
      )
      expect(store.getState().workItemsCache[initialCacheKey].data![0]).toBe(foreign)
      expect(JSON.stringify(foreign)).toBe(foreignData)
      expect(store.getState().workItemsCache[forkKey].data![1]).toBe(forkRows[1])
      expect(JSON.stringify(forkRows[1])).toBe(neighborData)
    }
    snapshot('fork admitted')
    const responses = [
      Promise.withResolvers<{ ok: boolean }>(),
      Promise.withResolvers<{ ok: boolean }>()
    ]
    update
      .mockImplementationOnce(() => responses[0].promise)
      .mockImplementationOnce(() => responses[1].promise)
    const start = (item: GitHubWorkItem, owner: string) =>
      taskMutation.run({
        item,
        sourceContext: source,
        intent: { type: 'toggleAssignee', user: user('cora') },
        mutate: () =>
          window.api.gh.updateIssueBySlug({
            owner,
            repo: 'r',
            host: 'github.com',
            number: item.number,
            updates: { addAssignees: ['cora'] }
          }),
        errorToast: 'Rejected'
      })
    let forkWrite: Promise<unknown>, upstreamWrite: Promise<unknown>
    await act(async () => {
      forkWrite = start(context.pages[2]![0], 'fork')
    })
    snapshot('fork pending')
    activeQuery = upstreamQuery
    await mount(false, outputs, activeQuery, true)
    snapshot('first query reset renews fork')
    let upstreamRows: readonly GitHubWorkItem[] = []
    await act(async () => {
      upstreamRows = await fetch('upstream', upstreamQuery, upstreamFirst)
    })
    const upstreamKey = keyFor(upstreamQuery)
    expect(getGitHubTaskObservation(upstreamRows[0])?.key).toBe(owner.key)
    expect(store.getState().workItemsCache[forkKey].fullFetchObservation?.key).toBe(owner.key)
    expect(store.getState().workItemsCache[upstreamKey].fullFetchObservation?.key).toBe(owner.key)
    expect(
      Object.keys(store.getState().workItemsCache).indexOf(upstreamKey) <
        Object.keys(store.getState().workItemsCache).indexOf(forkKey)
    ).toBe(upstreamFirst)
    await act(async () => harnessSetPages((current) => [current[2], null, [...upstreamRows]]))
    await act(async () => {
      upstreamWrite = start(context.pages[2]![0], 'upstream')
    })
    expect(update).toHaveBeenCalledTimes(2)
    expect(getTaskPageGitHubPendingEntries().size).toBe(2)
    expect(getTaskPageGitHubListEntries().size).toBe(2)
    snapshot('both canonical operations pending')
    activeQuery = forkQuery
    await mount(false, outputs, activeQuery, true)
    snapshot('second query reset renews both')
    await act(async () => {
      responses[0].resolve({ ok: false })
      responses[1].resolve({ ok: false })
      expect(await forkWrite!).toBe('rolled_back')
      expect(await upstreamWrite!).toBe('rolled_back')
    })
    snapshot('both callbacks failed, direct page settlement')
    expect(getTaskPageGitHubPendingEntries().size).toBe(0)
    expect(getTaskPageGitHubListEntries().size).toBe(0)
    for (const page of [0, 2]) {
      expect(context.pages[page]![0].assignees?.map((u) => u.login)).toEqual(['alice'])
      expect(
        gitHubTaskFamilyOrigin(context.pages[page]![0], 'assignees')?.listLifetime
      ).toBeUndefined()
    }
    await act(async () => {
      const entries = [
        store.getState().workItemsCache[forkKey],
        store.getState().workItemsCache[upstreamKey]
      ]
      admitTaskPageGitHubListInputs(
        entries.flatMap((entry) => entry.data ?? []),
        createTaskPageGitHubProjectionContext(store.getState().repos, parseTaskQuery(''), '', null),
        true
      )
      harnessSetPages((current) =>
        reconcileTaskPagePagesWithWorkItemsCache(current, entries).map((page) =>
          page ? (overlayPendingOnTaskPagePages([page])[0] ?? []) : null
        )
      )
    })
    snapshot('current cache reconciled into real Rows')
    for (const [key, page] of [
      [forkKey, 0],
      [upstreamKey, 2]
    ] as const) {
      expect
        .soft(
          store.getState().workItemsCache[key].data![0].assignees?.map((u) => u.login),
          key
        )
        .toEqual(['alice'])
      expect
        .soft(
          gitHubTaskFamilyOrigin(store.getState().workItemsCache[key].data![0], 'assignees')
            ?.listLifetime,
          key
        )
        .toBeUndefined()
      expect
        .soft(
          context.pages[page]![0].assignees?.map((u) => u.login),
          `page ${page}`
        )
        .toEqual(['alice'])
      const section = container.querySelector(`[data-retained-page="${page}"]`)!
      expect
        .soft(section.querySelector('[data-tasks] h3')?.textContent)
        .toBe(page === 0 ? fork.title : upstream.title)
      expect
        .soft(
          [...section.querySelectorAll('[data-tasks] img')].map((n) => n.getAttribute('title')),
          `page ${page} actual avatars`
        )
        .not.toContain('cora (cora)')
    }
    expect(list).toHaveBeenCalledTimes(upstreamFirst ? 3 : 2)
    expect(direct).toHaveBeenCalledTimes(directReads)
  }
)

it('keeps old-owner retirement instructions independent and ordered through the real cache sink, including aliases and ownerless PR first-match', async () => {
  const { beginTaskPageGitHubWorkItemMutation } =
    await import('@/components/task-page/github/task-page-github-work-item-mutations')
  const { transitionTaskPageGitHubMutationQuery } =
    await import('@/components/task-page/github/task-page-github-work-item-query-transition')
  const { captureGitHubTaskObservation, observeGitHubWorkItem } =
    await import('./github-task-observation')
  const {
    getTaskPageGitHubListEntries,
    resetTaskPageGitHubMutationRegistryForTests,
    setTaskPageGitHubMutationQueryKey
  } = await import('@/components/task-page/github/task-page-github-work-item-mutation-registry')
  const { createTaskPageGitHubAuthorityProjection } =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-composition')
  const { getTaskSourceCacheScope } = await import('../../../shared/task-source-context')
  const { workItemsCacheKey } = await import('@/store/github/cache-identity')
  store.setState({ workItemsCache: {} })
  const owners = ['alice', 'bob', 'cora'].map((login) => ({
    ...repo,
    ghAccount: { host: 'github.com', user: login }
  }))
  const observed = owners.map((owner) => captureGitHubTaskObservation(owner, source)!)
  const base = { ...seed, id: 'issue:5', assignees: [user('alice')] }
  const outputs = observed.slice(0, 2).map((observation) => {
    const item = observeGitHubWorkItem(base, observation, true)
    beginTaskPageGitHubWorkItemMutation({
      item,
      observation,
      sourceContext: source,
      intent: { type: 'toggleAssignee', user: user('cora') },
      query: parseTaskQuery('is:open'),
      queryKey: 'q',
      viewerLogin: 'alice',
      patchWorkItem: store.getState().patchWorkItem
    })
    const project = createTaskPageGitHubAuthorityProjection()
    return [
      project(item, getTaskSourceCacheScope(source), observation),
      project({ ...item, id: item.url }, getTaskSourceCacheScope(source), observation)
    ]
  })
  const [a, b] = outputs
  const current = observeGitHubWorkItem(base, observed[2], true)
  const duplicateA = { ...a[0] },
    duplicateB = { ...b[0] }
  const rows = [current, b[0], a[0], duplicateA, duplicateB, b[1], a[1], current]
  const bucket = workItemsCacheKey(repo.id, 30, 'contract', getTaskSourceCacheScope(source))
  const repeated = workItemsCacheKey(repo.id, 60, 'contract', getTaskSourceCacheScope(source))
  store.setState({
    repos: [owners[2]],
    workItemsCache: {
      [bucket]: { data: rows, fetchedAt: 17 },
      [repeated]: { data: rows, fetchedAt: 23 }
    }
  })
  const realPatch = store.getState().patchWorkItems
  const patch = vi.spyOn(store.getState(), 'patchWorkItems').mockImplementation(realPatch)
  transitionTaskPageGitHubMutationQuery('contract-reset', store.getState())
  const requests = patch.mock.calls[0][0]
  expect(requests).toHaveLength(4)
  expect(requests.map((request) => request.options?.observation?.key)).toEqual([
    observed[0].key,
    observed[0].key,
    observed[1].key,
    observed[1].key
  ])
  expect(requests.map((request) => request.itemId)).toEqual([base.id, base.url, base.id, base.url])
  for (const cacheKey of [bucket, repeated]) {
    const result = store.getState().workItemsCache[cacheKey]
    expect(result.fetchedAt).toBe(cacheKey === bucket ? 17 : 23)
    for (const index of [0, 3, 4, 7]) {
      expect(result.data![index]).toBe(rows[index])
    }
    for (const index of [1, 2, 5, 6]) {
      const item = result.data![index]
      const entry = [...getTaskPageGitHubListEntries().values()].find(
        (entry) => entry.observation?.key === getGitHubTaskObservation(item)?.key
      )!
      expect(gitHubTaskFamilyOrigin(item, 'assignees')?.listLifetime).toBe(entry.lifetime)
      expect(gitHubTaskFamilyOrigin(item, 'assignees')?.listLifetime).not.toBe(
        gitHubTaskFamilyOrigin(rows[index], 'assignees')?.listLifetime
      )
      expect(item.assignees?.map((u) => u.login)).toEqual(['alice', 'cora'])
    }
  }
  patch.mockRestore()
  resetTaskPageGitHubMutationRegistryForTests()
  setTaskPageGitHubMutationQueryKey('pr')
  store.setState({ workItemsCache: {} })
  const pr = { ...base, type: 'pr' as const, id: 'pr:5', url: 'https://github.com/o/r/pull/5' }
  beginTaskPageGitHubWorkItemMutation({
    item: pr,
    sourceContext: source,
    intent: { type: 'toggleAssignee', user: user('cora') },
    query: parseTaskQuery('is:open'),
    queryKey: 'pr',
    viewerLogin: 'alice',
    patchWorkItem: store.getState().patchWorkItem
  })
  const dependent = createTaskPageGitHubAuthorityProjection()(pr, getTaskSourceCacheScope(source))
  const first = { ...pr, url: 'https://github.com/other/r/pull/5' }
  store.setState({ workItemsCache: { [bucket]: { data: [first, dependent], fetchedAt: 29 } } })
  const prPatch = vi.spyOn(store.getState(), 'patchWorkItems').mockImplementation(realPatch)
  transitionTaskPageGitHubMutationQuery('pr-reset', store.getState())
  expect(prPatch.mock.calls[0][0]).toHaveLength(1)
  expect(prPatch.mock.calls[0][0][0].options?.ownerRepo).toBeUndefined()
  expect(store.getState().workItemsCache[bucket].data![0].assignees?.map((u) => u.login)).toEqual([
    'alice',
    'cora'
  ])
  expect(store.getState().workItemsCache[bucket].data![1]).toBe(dependent)
  prPatch.mockRestore()
})
it.each([false, true])(
  'compares production-issued alias Full resolution and preparation (legacy entry=%s)',
  async (legacyEntry) => {
    update.mockReset().mockResolvedValue({ ok: true })
    const { buildTaskSourceContextFromRepo } = await import('../../../shared/task-source-context')
    const { getTaskPageGitHubListEntries } =
      await import('@/components/task-page/github/task-page-github-work-item-mutation-registry')
    const { prepareWorkItemPatches } = await import('@/store/github/work-item-cache-patches')
    const { sameGitHubTaskObservation } = await import('./github-task-observation')
    const foreignRepo = {
      ...repo,
      id: 'foreign-alias-control',
      path: '/foreign-alias-control',
      ghAccount: { host: 'github.com', user: 'bob' }
    }
    store.setState({ repos: [repo, foreignRepo] })
    const legacy = buildTaskSourceContextFromRepo({ provider: 'github', projectId: repo.id, repo })!
    const writeSource = legacyEntry ? legacy : source,
      aliasSource = legacyEntry ? source : legacy
    let query = 'is:open'
    const ordinary = { ...seed, id: 'issue:5', assignees: [user('alice')] }
    const sources = { issues: { owner: 'o', repo: 'r' }, prs: null }
    list.mockResolvedValueOnce({ items: [ordinary], sources })
    const rows = await store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: writeSource })
    context.pages = [null, null, [...rows]]
    const outputs = (
      pages: (GitHubWorkItem[] | null)[],
      mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>,
      key: string,
      viewer: string | null
    ) => (
      <VisibleReaders
        pages={pages}
        mutation={mutation}
        queryKey={key}
        viewerLogin={viewer}
        query={query}
        kind="issues"
      />
    )
    await mount(false, outputs, query, true)
    const response = Promise.withResolvers<{ ok: boolean }>()
    let writing: Promise<unknown>
    update.mockReturnValueOnce(response.promise)
    await act(async () => {
      writing = taskMutation.run({
        item: context.pages[2]![0],
        sourceContext: writeSource,
        intent: { type: 'toggleAssignee', user: user('cora') },
        mutate: () =>
          window.api.gh.updateIssueBySlug({
            owner: 'o',
            repo: 'r',
            host: 'github.com',
            number: 5,
            updates: { addAssignees: ['cora'] }
          }),
        errorToast: 'Rejected'
      })
    })
    // Only the real transport is held; no provider entity or provenance is synthesized.
    const owner = getGitHubTaskObservation(rows[0])!
    list.mockResolvedValueOnce({ items: [{ ...ordinary, assignees: [] }], sources })
    const foreign = await store
      .getState()
      .fetchWorkItems(foreignRepo.id, foreignRepo.path, 30, 'foreign-alias-control', {
        sourceContext: getTaskPageRepoSourceContext(foreignRepo, 'github')
      })
    const foreignData = JSON.stringify(foreign[0])
    expect(sameGitHubTaskObservation(getGitHubTaskObservation(foreign[0]), owner)).toBe(false)
    list.mockResolvedValueOnce({ items: [{ ...ordinary, assignees: [] }], sources })
    const alias = await store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: aliasSource, force: true })
    const aliasOwner = getGitHubTaskObservation(alias[0])!
    expect(aliasOwner.key).not.toBe(owner.key)
    expect(sameGitHubTaskObservation(aliasOwner, owner)).toBe(true)
    expect(gitHubTaskFamilyOrigin(alias[0], 'assignees')?.completeFamily).toBe(true)
    const realPatch = store.getState().patchWorkItems
    const patch = vi.spyOn(store.getState(), 'patchWorkItems').mockImplementation((requests) => {
      const prepared = prepareWorkItemPatches(store.getState(), requests, true)
      console.info(
        'R5-BOUNDARY-ALIAS',
        JSON.stringify({
          legacyEntry,
          owner: owner.key,
          aliasOwner: aliasOwner.key,
          plans: requests
            .flatMap((r) => r.options?.listComposition ?? [])
            .map((p) => ({
              restoration: p.retirement?.restoration,
              oldOwner: p.address.observation?.key
            })),
          prepared: prepared.existingEntryBaseObservations.map((o) => ({
            owner: o.address.observation?.key,
            input: o.input
          }))
        })
      )
      return realPatch(requests)
    })
    try {
      query = 'is:open assignee:cora'
      await mount(false, outputs, query, true)
      const entry = [...getTaskPageGitHubListEntries().values()][0]
      console.info(
        'R5-BOUNDARY-ALIAS-FINAL',
        JSON.stringify({
          legacyEntry,
          base: entry?.base,
          pages: context.pages,
          cache: store.getState().workItemsCache,
          avatars: [...container.querySelectorAll('[data-tasks] img')].map((n) =>
            n.getAttribute('title')
          )
        })
      )
      expect
        .soft(
          entry.base.users.map((u) => u.login),
          'independent empty alias Full first'
        )
        .toEqual([])
      await act(async () => {
        response.resolve({ ok: false })
        expect(await writing!).toBe('rolled_back')
      })
      expect
        .soft(
          context.pages[2]![0].assignees?.map((u) => u.login),
          'no stale alias refill'
        )
        .toEqual([])
      expect(
        store.getState().workItemsCache[
          Object.keys(store.getState().workItemsCache).find((key) =>
            key.endsWith('foreign-alias-control')
          )!
        ].data![0]
      ).toBe(foreign[0])
      expect(JSON.stringify(foreign[0])).toBe(foreignData)
    } finally {
      patch.mockRestore()
    }
  }
)
