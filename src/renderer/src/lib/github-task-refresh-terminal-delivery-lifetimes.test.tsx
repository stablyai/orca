// @vitest-environment happy-dom
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
import { parseTaskQuery } from '../../../shared/task-query'

import {
  repo,
  source,
  seed,
  user,
  key as initialCacheKey
} from './github-task-refresh-data.test-fixture'

import React, { act } from 'react'

import { expect, it, vi } from 'vitest'

import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

import type { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'

import { getTaskPageRepoSourceContext } from '@/lib/task-repo-source-context'

import { gitHubTaskFamilyOrigin } from './github-task-observation'

import { createTaskPageGitHubProjectionContext } from '@/components/task-page/github/task-page-github-work-item-mutation-pages'

import { reconcileTaskPagePagesWithWorkItemsCache } from '@/components/task-page/task-page-cache-selectors'

import { VisibleReaders } from './github-task-refresh-visible-readers.test-fixture'

it.each([
  false,
  true,
  'terminal',
  'queued',
  'ordinary',
  'absence',
  'force',
  'replacement'
] as const)(
  'retains an acknowledged Cora edit through query reset and a second Dora edit (boundary=%s)',
  async (boundary) => {
    update.mockReset().mockResolvedValue({ ok: true })
    const doraPendingAtReset = boundary === true,
      queued = boundary === 'queued' || boundary === 'ordinary'
    const terminal = boundary === 'terminal' || queued
    const { beginGitHubTaskRead } = await import('@/store/github/request-coordination')
    const { getTaskPageGitHubListEntries, getTaskPageGitHubPendingEntries } =
      await import('@/components/task-page/github/task-page-github-work-item-mutation-registry')
    const {
      admitTaskPageGitHubListInputs,
      overlayPendingOnTaskPagePages,
      restoreTaskPageGitHubReadPage
    } = await import('@/components/task-page/github/task-page-github-work-item-mutation-pages')
    const { taskPageGitHubResumeCache } =
      await import('@/components/task-page/github/task-page-github-resume-cache')
    const { useSmartWorkspaceGithubSearch } =
      await import('@/components/new-workspace/use-smart-workspace-github-search')
    const { useGitHubTaskDeliveryState } = await import('@/hooks/useGitHubTaskDeliveryState')
    const otherRepo = { ...repo, id: 'held-sibling', path: '/held-sibling' }
    if (terminal) {
      store.setState({ repos: [repo, otherRepo] })
    }
    let query = 'is:open',
      smartEnabled = false
    const ordinary = { ...seed, id: 'issue:5', assignees: [user('alice')] }
    const neighbor = {
      ...ordinary,
      id: 'issue:4',
      number: 4,
      url: 'https://github.com/o/r/issues/4',
      title: 'Untouched confirmed-reset neighbor'
    }
    list.mockResolvedValueOnce({
      items: [ordinary, neighbor],
      sources: { issues: { owner: 'o', repo: 'r' }, prs: null }
    })
    const rows = await store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: source })
    if (terminal) {
      list.mockResolvedValueOnce({
        items: [ordinary, neighbor],
        sources: { issues: { owner: 'o', repo: 'r' }, prs: null }
      })
      await store
        .getState()
        .fetchWorkItems(repo.id, repo.path, 12, query, { sourceContext: source })
    }
    const cacheKey = Object.keys(store.getState().workItemsCache).find((key) =>
      key.endsWith(query)
    )!
    const fullOwner = store.getState().workItemsCache[cacheKey].fullFetchObservation
    const foreign = store.getState().workItemsCache[initialCacheKey].data![1]
    const foreignData = JSON.stringify(foreign),
      neighborData = JSON.stringify(rows[1])
    context.pages = [null, null, rows]
    let queryKey = '',
      viewer: string | null = null
    const smartRepos = store.getState().repos
    const targets = smartRepos.map((registered) => ({
      repo: registered,
      githubSourceContext: getTaskPageRepoSourceContext(registered, 'github')
    }))
    const handled = { current: '' },
      slugs = { current: new Map<string, string>() }
    const noop = () => {}
    let smartItems: GitHubWorkItem[] = [],
      smartCommits = 0
    let aggregateReturn: GitHubWorkItem[] | undefined
    let queuedUpdater: ((current: GitHubWorkItem[]) => GitHubWorkItem[]) | undefined
    let commitSmart!: React.Dispatch<React.SetStateAction<GitHubWorkItem[]>>
    let finalPhase = 'waiting'
    const fetchSmart: ReturnType<typeof store.getState>['fetchWorkItemsAcrossRepos'] = async (
      ...args
    ) => {
      const result = await store.getState().fetchWorkItemsAcrossRepos(...args)
      aggregateReturn = result.items
      console.info(
        'R5-B1-AGGREGATE-RETURN',
        JSON.stringify({
          boundary,
          items: result.items.map(describe),
          cache: store.getState().workItemsCache
        })
      )
      return result
    }
    const setSmart: React.Dispatch<React.SetStateAction<GitHubWorkItem[]>> = (action) => {
      // Hold the real updater at its injected setter; this models deferral, not React scheduling.
      if (typeof action === 'function' && queued) {
        queuedUpdater = action
        console.info(
          'R5-B1-UPDATER-ENQUEUED',
          JSON.stringify({
            boundary,
            current: smartItems.map(describe),
            returned: aggregateReturn?.map(describe)
          })
        )
      } else {
        commitSmart(action)
      }
    }
    function SmartFinalOwner({
      mutation
    }: {
      mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>
    }) {
      const [items, setItems] = useGitHubTaskDeliveryState<GitHubWorkItem[]>([])
      React.useLayoutEffect(() => {
        smartItems = items
        smartCommits += 1
        commitSmart = setItems
      }, [items, setItems])
      useSmartWorkspaceGithubSearch({
        foundation: {
          debouncedQuery: 'is:open',
          disabled: false,
          handledCrossRepoUrlRef: handled,
          repoSlugCacheRef: slugs,
          crossRepoSwitchTarget: null,
          repoBackedSearchTargets: targets,
          selectedRepo: repo,
          githubSourceContext: source,
          repos: smartRepos,
          getCachedWorkItems: store.getState().getCachedWorkItems,
          fetchWorkItems: store.getState().fetchWorkItems,
          fetchWorkItemsAcrossRepos: fetchSmart,
          setGithubItems: setSmart,
          setGithubLoading: noop,
          setCrossRepoPrompt: noop
        } as Parameters<typeof useSmartWorkspaceGithubSearch>[0]['foundation'],
        sourceQueryWithinLimit: true,
        shouldQueryGithub: true
      })
      // SAFETY: the production search hook reads exactly the supplied foundation fields on this list branch.
      return (
        <section data-smart-final>
          <VisibleReaders
            pages={[null, null, items]}
            mutation={mutation}
            queryKey={queryKey}
            viewerLogin={viewer}
            query="is:open"
            kind="issues"
          />
        </section>
      )
    }
    const outputs = (
      pages: (GitHubWorkItem[] | null)[],
      mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>,
      key: string,
      viewerLogin: string | null
    ) => {
      queryKey = key
      viewer = viewerLogin
      return (
        <>
          <VisibleReaders
            pages={pages}
            mutation={mutation}
            queryKey={key}
            viewerLogin={viewerLogin}
            query={query}
            kind="issues"
          />
          {smartEnabled && <SmartFinalOwner mutation={mutation} />}
        </>
      )
    }
    await mount(false, outputs, query, true)
    const directCount = direct.mock.calls.length
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
        id: row.id,
        repoId: row.repoId,
        url: row.url,
        host: row.repoHostId,
        title: row.title,
        labels: row.labels,
        reviewRequests: row.reviewRequests,
        users: row.assignees?.map((u) => u.login),
        origin: origin?.kind,
        owner: origin?.owner?.key,
        completeFamily: origin?.completeFamily,
        lifetime: tokenId(origin?.listLifetime)
      }
    }
    const snapshot = (stage: string) => {
      console.info(
        'R5-CONFIRMED-RESET',
        JSON.stringify({
          boundary,
          doraPendingAtReset,
          stage,
          cache: store.getState().workItemsCache[cacheKey].data?.map(describe),
          fullFetchOwner: store.getState().workItemsCache[cacheKey].fullFetchObservation?.key,
          pages: context.pages.map((page) => page?.map(describe) ?? null),
          resume: taskPageGitHubResumeCache.read('confirmed-reset', 2, 11)?.items.map(describe),
          entries: [...getTaskPageGitHubListEntries().values()].map((entry) => ({
            lifetime: tokenId(entry.lifetime),
            base: entry.base.kind,
            baseUsers: entry.base.users.map((u) => u.login),
            protection: entry.protection.kind,
            expected:
              entry.protection.kind === 'whole'
                ? entry.protection.expectedUsers.map((u) => u.login)
                : undefined,
            confirmed: entry.protection.kind === 'whole' ? entry.protection.confirmed : undefined,
            facts:
              entry.protection.kind === 'addressed' ? [...entry.protection.facts.keys()] : undefined
          })),
          pending: [...getTaskPageGitHubPendingEntries().values()].map((op) => ({
            generation: op.generation,
            listOp: op.listOp
          })),
          visible: [...container.querySelectorAll('[data-tasks] h3')].map((n) => n.textContent),
          avatars: [...container.querySelectorAll('[data-tasks] img')].map((n) =>
            n.getAttribute('title')
          ),
          count: container.querySelector('[data-visible-count]')?.textContent,
          smart: smartItems.map(describe),
          smartCommits,
          listCalls: list.mock.calls,
          updateCalls: update.mock.calls
        })
      )
      expect(store.getState().workItemsCache[initialCacheKey].data![1]).toBe(foreign)
      expect(JSON.stringify(foreign)).toBe(foreignData)
      expect(store.getState().workItemsCache[cacheKey].data![1]).toBe(rows[1])
      expect(context.pages[2]![1]).toBe(rows[1])
      expect(JSON.stringify(rows[1])).toBe(neighborData)
      if (boundary === 'replacement') {
        expect(store.getState().workItemsCache[cacheKey].fullFetchObservation?.key).toBe(
          fullOwner?.key
        )
      } else {
        expect(store.getState().workItemsCache[cacheKey].fullFetchObservation).toBe(fullOwner)
      }
    }
    const start = (login: string) =>
      taskMutation.run({
        item: context.pages[2]![0],
        sourceContext: source,
        intent: { type: 'toggleAssignee', user: user(login) },
        mutate: () =>
          window.api.gh.updateIssueBySlug({
            owner: 'o',
            repo: 'r',
            host: 'github.com',
            number: 5,
            updates: { addAssignees: [login] }
          }),
        errorToast: 'Rejected'
      })
    snapshot('genuine Full Alice')
    await act(async () => {
      expect(await start('cora')).toBe('confirmed')
    })
    expect(context.pages[2]![0].assignees?.map((u) => u.login)).toEqual(['alice', 'cora'])
    expect(getTaskPageGitHubPendingEntries().size).toBe(0)
    snapshot('Cora acknowledged, no ordinary adoption')
    const dora = Promise.withResolvers<{ ok: boolean }>()
    if (boundary !== 'absence' && boundary !== 'force' && boundary !== 'replacement') {
      update.mockReturnValueOnce(dora.promise)
    }
    let writing: Promise<unknown>
    if (doraPendingAtReset) {
      await act(async () => {
        writing = start('dora')
      })
    }
    taskPageGitHubResumeCache.write('confirmed-reset', 2, context.pages[2]!, 10)
    const read = beginGitHubTaskRead(
      [{ repoId: repo.id, path: repo.path, sourceContext: source }],
      undefined,
      store.getState()
    )
    const coordination = await import('@/store/github/request-coordination')
    const realBegin = coordination.beginGitHubTaskRead
    const readRecords: { sourceCount: number; disposed: boolean; retirements: number }[] = []
    const restores: (() => void)[] = []
    if (terminal) {
      const beginSpy = vi
        .spyOn(coordination, 'beginGitHubTaskRead')
        .mockImplementation((...args) => {
          const actual = realBegin(...args)
          const record = { sourceCount: args[0].length, disposed: false, retirements: 0 }
          readRecords.push(record)
          const apply = actual.apply,
            dispose = actual.dispose,
            retire = actual.retire
          const applySpy = vi.spyOn(actual, 'apply').mockImplementation((input, current) => {
            const result = apply(input, current)
            if (finalPhase !== 'waiting' && record.sourceCount === 2) {
              expect(input).toBe(aggregateReturn)
            }
            console.info(
              'R5-B1-REAL-APPLY',
              JSON.stringify({
                boundary,
                finalPhase,
                record,
                aggregateInput: input === aggregateReturn,
                input: input.map(describe),
                current: current?.map(describe),
                result: result.map(describe)
              })
            )
            return result
          })
          const disposeSpy = vi.spyOn(actual, 'dispose').mockImplementation(() => {
            record.disposed = true
            dispose()
            console.info('R5-B1-DISPOSE', JSON.stringify({ boundary, record }))
          })
          const retireSpy = vi.spyOn(actual, 'retire').mockImplementation((index) => {
            record.retirements += 1
            retire(index)
          })
          restores.push(() => {
            applySpy.mockRestore()
            disposeSpy.mockRestore()
            retireSpy.mockRestore()
          })
          return actual
        })
      restores.push(() => beginSpy.mockRestore())
    }
    try {
      list.mockRejectedValueOnce(new Error('Expected held composed-cache fallback'))
      const held = await store
        .getState()
        .fetchWorkItemsAcrossRepos(
          [{ repoId: repo.id, path: repo.path, sourceContext: source }],
          30,
          30,
          query,
          { force: true, taskRead: read }
        )
      expect(held.items[0].assignees?.map((u) => u.login)).toContain('cora')
      if (boundary === 'absence' || boundary === 'force' || boundary === 'replacement') {
        const {
          clearTaskPageGitHubAuthorityAbsentFromLoadedItems,
          clearTaskPageGitHubAuthorityThroughGeneration
        } =
          await import('@/components/task-page/github/task-page-github-work-item-authority-refresh')
        const { getOrCreateQuietRevalidateState } =
          await import('@/components/task-page/github/task-page-github-work-item-quiet-state')
        const { taskPageGitHubOwnedItemKey } =
          await import('@/components/task-page/github/task-page-github-work-item-mutation-keys')
        const entry = [...getTaskPageGitHubListEntries().values()][0]
        const owns = (owner: typeof entry.observation) => owner?.key === entry.observation?.key
        const generation = getOrCreateQuietRevalidateState(queryKey).dirtyGeneration
        if (boundary === 'replacement') {
          list.mockResolvedValueOnce({
            items: [{ ...ordinary, assignees: [] }, neighbor],
            sources: { issues: { owner: 'o', repo: 'r' }, prs: null }
          })
          await act(async () => {
            await store
              .getState()
              .fetchWorkItems(repo.id, repo.path, 30, query, { sourceContext: source, force: true })
          })
        }
        await act(async () => {
          if (boundary === 'absence') {
            clearTaskPageGitHubAuthorityAbsentFromLoadedItems(
              new Set([
                taskPageGitHubOwnedItemKey(
                  entry.sourceScope,
                  entry.repoId,
                  entry.itemId,
                  entry.observation?.key
                )
              ]),
              owns
            )
            expect([...getTaskPageGitHubListEntries().values()][0]).toBe(entry)
            clearTaskPageGitHubAuthorityAbsentFromLoadedItems(new Set(), () => false)
            expect([...getTaskPageGitHubListEntries().values()][0]).toBe(entry)
            clearTaskPageGitHubAuthorityAbsentFromLoadedItems(new Set(), owns)
          } else {
            clearTaskPageGitHubAuthorityThroughGeneration(queryKey, generation - 1, owns)
            expect(getTaskPageGitHubListEntries().size).toBe(1)
            clearTaskPageGitHubAuthorityThroughGeneration(
              queryKey,
              generation,
              owns,
              boundary === 'replacement'
                ? (store.getState().workItemsCache[cacheKey].data ?? [])
                : []
            )
          }
          harnessSetPages((current) => restoreTaskPageGitHubReadPage(read, current, held.items, 2))
        })
        snapshot('scoped cleanup and final retained read')
        expect(getTaskPageGitHubListEntries().size).toBe(0)
        expect(getTaskPageGitHubPendingEntries().size).toBe(0)
        const expected = boundary === 'replacement' ? [] : ['alice', 'cora']
        expect
          .soft(
            context.pages[2]![0].assignees?.map((u) => u.login),
            boundary
          )
          .toEqual(expected)
        expect
          .soft(
            taskPageGitHubResumeCache
              .read('confirmed-reset', 2, 11)
              ?.items[0].assignees?.map((u) => u.login),
            `${boundary} resume`
          )
          .toEqual(expected)
        if (boundary !== 'replacement') {
          expect
            .soft(
              gitHubTaskFamilyOrigin(context.pages[2]![0], 'assignees')?.completeFamily,
              `${boundary} cannot certify old Full`
            )
            .toBeUndefined()
        }
        expect(
          store.getState().workItemsCache[cacheKey].data![0].assignees?.map((u) => u.login)
        ).toEqual(expected)
        expect
          .soft(
            [...container.querySelectorAll('[data-tasks] img')]
              .map((n) => n.getAttribute('title'))
              .includes('cora (cora)'),
            `${boundary} avatars`
          )
          .toBe(boundary !== 'replacement')
        expect(update).toHaveBeenCalledTimes(1)
        expect(list).toHaveBeenCalledTimes(boundary === 'replacement' ? 3 : 2)
        expect(direct).toHaveBeenCalledTimes(directCount)
        return
      }
      const sibling = Promise.withResolvers<{
        items: GitHubWorkItem[]
        sources: { issues: null; prs: null }
      }>()
      if (terminal) {
        if (queued) {
          store.getState().patchWorkItem('issue:5', { labels: ['Independent static Y'] }, repo.id, {
            sourceContext: source
          })
        }
        list.mockImplementation((args: { repoId: string }) => {
          expect(args.repoId).toBe(otherRepo.id)
          return sibling.promise
        })
        smartEnabled = true
        await mount(false, outputs, query, true)
        expect(smartItems).toEqual([])
      }
      query = 'is:open assignee:alice'
      await mount(false, outputs, query, true)
      snapshot('Q2 reset before any new full')
      const networkSibling = {
        ...ordinary,
        id: 'issue:7',
        number: 7,
        url: 'https://github.com/other/r/issues/7',
        title: 'Genuine network sibling Y',
        labels: ['Provider sibling'],
        assignees: [user('network')]
      }
      if (queued) {
        await act(async () =>
          sibling.resolve({ items: [networkSibling], sources: { issues: null, prs: null } })
        )
        expect(aggregateReturn).toBeDefined()
        expect(queuedUpdater).toBeTypeOf('function')
        expect(smartItems).toEqual([])
        expect(readRecords.find((record) => record.sourceCount === 2)?.disposed).toBe(false)
        snapshot('aggregate returned and real finally disposed BEFORE Dora')
      }
      expect
        .soft(
          taskPageGitHubResumeCache
            .read('confirmed-reset', 2, 11)
            ?.items[0].assignees?.map((u) => u.login),
          'retained resume after reset'
        )
        .toContain('cora')
      query = 'is:open'
      await mount(false, outputs, query, true)
      await act(async () => {
        const entry = store.getState().workItemsCache[cacheKey]
        const projection = createTaskPageGitHubProjectionContext(
          store.getState().repos,
          parseTaskQuery(query),
          queryKey,
          viewer
        )
        admitTaskPageGitHubListInputs(entry.data ?? [], projection, true)
        harnessSetPages((current) =>
          reconcileTaskPagePagesWithWorkItemsCache(current, [entry]).map((page) =>
            page ? overlayPendingOnTaskPagePages([page], projection)[0] : null
          )
        )
      })
      if (!terminal) {
        await act(async () =>
          harnessSetPages((current) => restoreTaskPageGitHubReadPage(read, current, held.items, 2))
        )
      }
      snapshot('Q1 cache reconciliation and held-read materialization')
      expect
        .soft(
          context.pages[2]![0].assignees?.map((u) => u.login),
          'reentered page'
        )
        .toContain('cora')
      expect
        .soft(
          store.getState().workItemsCache[cacheKey].data![0].assignees?.map((u) => u.login),
          'reentered cache'
        )
        .toContain('cora')
      expect
        .soft(
          [...container.querySelectorAll('[data-tasks] img')].map((n) => n.getAttribute('title')),
          'actual reentered avatars'
        )
        .toContain('cora (cora)')
      if (!doraPendingAtReset) {
        await act(async () => {
          writing = start('dora')
        })
      }
      snapshot('Dora pending before any new full')
      expect
        .soft(
          context.pages[2]![0].assignees?.map((u) => u.login),
          'second edit composition'
        )
        .toEqual(['alice', 'cora', 'dora'])
      await act(async () => {
        dora.resolve({ ok: true })
        expect(await writing!).toBe('confirmed')
      })
      snapshot('Dora acknowledged without new full')
      expect
        .soft(
          context.pages[2]![0].assignees?.map((u) => u.login),
          'final acknowledged data'
        )
        .toEqual(['alice', 'cora', 'dora'])
      if (terminal) {
        expect(context.pages[2]![0].assignees?.map((u) => u.login)).toContain('dora')
        query = 'is:open assignee:dora'
        await mount(false, outputs, query, true)
        snapshot('R2 terminal retirement BEFORE old L1 final output')
        expect
          .soft(
            context.pages[2]![0].assignees?.map((u) => u.login),
            'R2 before held final'
          )
          .toEqual(['alice', 'cora', 'dora'])
        expect(getTaskPageGitHubListEntries().size).toBe(0)
        expect(getTaskPageGitHubPendingEntries().size).toBe(0)
        expect(
          context.pages[2]![0].assignees?.map((u) => u.login),
          'correct R2 gates final interpretation'
        ).toEqual(['alice', 'cora', 'dora'])
        const r2Origin = gitHubTaskFamilyOrigin(context.pages[2]![0], 'assignees')
        expect(r2Origin?.kind).toBe('ordinary')
        expect(r2Origin?.owner?.key).toBe(fullOwner?.key)
        expect(r2Origin?.listLifetime).toBeUndefined()
        expect(r2Origin?.coordinate).toBeUndefined()
        expect(r2Origin?.generation).toBeUndefined()
        expect.soft(r2Origin?.completeFamily, 'R2 cannot certify old Full').toBeUndefined()
        await act(async () => {
          harnessSetPages((current) => restoreTaskPageGitHubReadPage(read, current, held.items, 2))
          if (!queued) {
            sibling.resolve({ items: [], sources: { issues: null, prs: null } })
          }
        })
        if (queued) {
          if (boundary === 'ordinary') {
            await act(async () =>
              store
                .getState()
                .patchWorkItem(rows[0].id, { title: 'Ordinary later delivery' }, repo.id, {
                  sourceContext: source,
                  observation: fullOwner,
                  ownerRepo: { owner: 'o', repo: 'r', host: 'github.com' }
                })
            )
          }
          if (!queuedUpdater) {
            throw new Error('Actual smart updater was not captured')
          }
          const snapshotInput: GitHubWorkItem[] = []
          const stateBefore = store.getState(),
            cacheBefore = stateBefore.workItemsCache
          let recordsBefore = JSON.stringify(readRecords)
          const networkBefore = [
            list.mock.calls.length,
            update.mock.calls.length,
            direct.mock.calls.length
          ]
          let storeNotifications = 0,
            registryNotifications = 0
          const unsubscribe = store.subscribe(() => {
            storeNotifications += 1
          })
          const registry =
            await import('@/components/task-page/github/task-page-github-work-item-mutation-registry')
          const unlisten = registry.subscribeTaskPageGitHubMutationRegistry(() => {
            registryNotifications += 1
          })
          try {
            finalPhase = 'deferred production updater through actual React setter'
            await act(async () => commitSmart(queuedUpdater))
            expect(readRecords.find((record) => record.sourceCount === 2)?.disposed).toBe(true)
            recordsBefore = JSON.stringify(readRecords)
            finalPhase = 'same actual updater replay, same explicit empty input'
            const first = queuedUpdater(snapshotInput),
              second = queuedUpdater(snapshotInput)
            expect(first).toEqual(second)
            expect(snapshotInput).toEqual([])
            const siblingRow = aggregateReturn?.find((row) => row.repoId === otherRepo.id)
            expect(first.find((row) => row.repoId === otherRepo.id)).toBe(siblingRow)
            expect(siblingRow?.title).toBe('Genuine network sibling Y')
            expect(first.find((row) => row.repoId === repo.id && row.number === 5)?.labels).toEqual(
              ['Independent static Y']
            )
            expect(store.getState()).toBe(stateBefore)
            expect(store.getState().workItemsCache).toBe(cacheBefore)
            expect(JSON.stringify(readRecords)).toBe(recordsBefore)
            expect([storeNotifications, registryNotifications]).toEqual([0, 0])
            expect([
              list.mock.calls.length,
              update.mock.calls.length,
              direct.mock.calls.length
            ]).toEqual(networkBefore)
            console.info(
              'R5-B1-REPLAY-PURITY',
              JSON.stringify({
                boundary,
                readRecords,
                storeNotifications,
                registryNotifications,
                networkBefore,
                returned: aggregateReturn?.map(describe),
                result: first.map(describe)
              })
            )
          } finally {
            unsubscribe()
            unlisten()
          }
        }
        snapshot('old L1 setter and surviving smart aggregate FINAL')
        if (boundary === 'ordinary') {
          expect(smartItems.find((row) => row.repoId === repo.id && row.number === 5)?.title).toBe(
            'Ordinary later delivery'
          )
        }
        expect
          .soft(
            context.pages[2]![0].assignees?.map((u) => u.login),
            'old L1 final'
          )
          .toEqual(['alice', 'cora', 'dora'])
        expect
          .soft(
            smartItems
              .find((row) => row.repoId === repo.id && row.number === 5)
              ?.assignees?.map((u) => u.login),
            'actual smart final setter'
          )
          .toEqual(['alice', 'cora', 'dora'])
        expect
          .soft(
            [...container.querySelectorAll('[data-smart-final] [data-tasks] img')].map((n) =>
              n.getAttribute('title')
            ),
            'actual smart final avatars'
          )
          .toContain('dora (dora)')
        if (queued) {
          if (!queuedUpdater) {
            throw new Error('Actual smart updater was not captured')
          }
          list.mockResolvedValueOnce({
            items: [{ ...ordinary, assignees: [] }, neighbor],
            sources: { issues: { owner: 'o', repo: 'r' }, prs: null }
          })
          const currentFull = await store
            .getState()
            .fetchWorkItems(repo.id, repo.path, 30, 'is:open', {
              sourceContext: source,
              force: true
            })
          expect(gitHubTaskFamilyOrigin(currentFull[0], 'assignees')?.completeFamily).toBe(true)
          finalPhase = 'same queued function with genuine current Full empty'
          await act(async () => {
            commitSmart(currentFull)
            commitSmart(queuedUpdater)
          })
          const finalTarget = smartItems.find((row) => row.repoId === repo.id && row.number === 5)!
          console.info(
            'R5-B1-FULL-EMPTY-CONTROL',
            JSON.stringify({
              boundary,
              current: currentFull.map(describe),
              final: smartItems.map(describe)
            })
          )
          expect
            .soft(
              finalTarget.assignees,
              'actual queued function must respect qualified current empty Full'
            )
            .toEqual([])
          expect
            .soft(
              gitHubTaskFamilyOrigin(finalTarget, 'assignees')?.completeFamily,
              'qualified current Full provenance'
            )
            .toBe(true)
          expect(finalTarget.labels).toEqual(['Independent static Y'])
          expect(store.getState().workItemsCache[initialCacheKey].data![1]).toBe(foreign)
          expect(JSON.stringify(foreign)).toBe(foreignData)
        }
      }
      expect(getTaskPageGitHubPendingEntries().size).toBe(0)
      expect(list).toHaveBeenCalledTimes(queued ? 5 : terminal ? 4 : 2)
      expect(update).toHaveBeenCalledTimes(2)
      expect(direct).toHaveBeenCalledTimes(directCount)
    } finally {
      read.dispose()
      for (const restore of restores.toReversed()) {
        restore()
      }
    }
  }
)
