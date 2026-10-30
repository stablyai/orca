// @vitest-environment happy-dom
import './github-task-refresh.test-fixture'

import {
  context,
  store,
  mount,
  direct,
  list,
  update,
  container
} from './github-task-refresh.test-fixture'

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

import { getGitHubTaskObservation } from './github-task-observation'

import { gitHubTaskFamilyOrigin } from './github-task-observation'

it('keeps the accepted DIRECT title in the native smart row and its whole selection callback', async () => {
  const { click } = await import('./github-task-refresh.test-fixture')
  const { useSmartWorkspaceNameFieldController } =
    await import('@/components/new-workspace/use-smart-workspace-name-field-controller')
  const { RowIcon, RowLabel } =
    await import('@/components/new-workspace/smart-workspace-source-row-content')
  const coordination = await import('@/store/github/request-coordination')
  const { getLocalPreflightContext, localPreflightContextKey } =
    await import('@/lib/local-preflight-context')
  const { getTaskSourceCacheScope } = await import('../../../shared/task-source-context')
  const { workItemsCacheKey } = await import('@/store/github/cache-identity')
  const { WORK_ITEMS_CACHE_TTL } = await import('@/store/github/cache-policy')
  const { isGitHubTaskObservationCurrent } = await import('./github-task-observation')
  const { getTaskPageGitHubListEntries, getTaskPageGitHubPendingEntries } =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-registry')
  const { workItemDetailsCache } =
    await import('@/components/github-item-dialog/load-item-details/work-item-details-cache')
  const query = 'is:open',
    registeredRepos = store.getState().repos
  const old = { ...seed, id: 'issue:5', title: 'Old', assignees: [user('alice')] }
  const neighbor = {
    ...old,
    id: 'issue:6',
    number: 6,
    url: 'https://github.com/o/r/issues/6',
    title: 'Unrelated neighbor'
  }
  const sources = { issues: { owner: 'o', repo: 'r' }, prs: null }
  const bucket = workItemsCacheKey(repo.id, 12, query, getTaskSourceCacheScope(source))
  const foreign = store.getState().workItemsCache[initialCacheKey].data![1]
  const foreignData = JSON.stringify(foreign)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  list.mockResolvedValueOnce({ items: [old, neighbor], sources })
  const admitted = await store
    .getState()
    .fetchWorkItems(repo.id, repo.path, 12, query, { sourceContext: source })
  const seededCache = store.getState().workItemsCache[bucket].data!
  const owner = getGitHubTaskObservation(admitted[0])!
  const neighborData = JSON.stringify(admitted[1])
  context.pages = [null, null, admitted]
  context.openedItem = admitted[0]
  clock.mockReturnValue(
    store.getState().workItemsCache[bucket].fetchedAt + WORK_ITEMS_CACHE_TTL + 1
  )
  // Only ancillary provider availability is supplied; GitHub actions and subscriptions stay real.
  Object.assign(window.api, {
    linear: { status: vi.fn().mockResolvedValue({ connected: false, viewer: null }) }
  })
  store.setState({
    preflightStatus: {
      git: { installed: true },
      gh: { installed: true, authenticated: true },
      glab: { installed: false, authenticated: false }
    },
    preflightStatusChecked: true,
    preflightStatusContextKey: localPreflightContextKey(getLocalPreflightContext(store.getState()))
  })
  direct.mockResolvedValueOnce({ item: old, body: 'Old body', comments: [] })
  let smartEnabled = false
  let model: ReturnType<typeof useSmartWorkspaceNameFieldController> | undefined
  const selected = vi.fn(),
    noop = () => {}
  const props = {
    repos: registeredRepos,
    repoId: repo.id,
    selectedRepo: repo,
    githubSourceContext: source,
    value: query,
    branchesEnabled: false,
    onRepoChange: noop,
    onValueChange: noop,
    onGitHubItemSelect: selected,
    onBranchSelect: noop,
    onLinearIssueSelect: noop,
    selectedSource: null,
    onClearSelectedSource: noop
  }
  function SmartTitleOwner() {
    const current = useSmartWorkspaceNameFieldController(props)
    React.useLayoutEffect(() => {
      model = current
    })
    return (
      <section data-native-smart>
        {current.rows
          .filter((row) => row.kind === 'github')
          .map((row) => (
            <button
              key={row.value}
              data-native-issue={row.item.url}
              onClick={() => current.handleSelect(row)}
            >
              <RowIcon row={row} />
              <RowLabel row={row} />
            </button>
          ))}
      </section>
    )
  }
  const outputs = () => (smartEnabled ? <SmartTitleOwner /> : null)
  const describe = (row: GitHubWorkItem) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    repoId: row.repoId,
    host: row.repoHostId,
    observation: getGitHubTaskObservation(row),
    assignees: row.assignees,
    origins: {
      assignees: gitHubTaskFamilyOrigin(row, 'assignees'),
      state: gitHubTaskFamilyOrigin(row, 'state')
    }
  })
  const reads: { id: number; disposed: boolean; marks: number; applications: unknown[] }[] = []
  const readSpies: { mockRestore: () => void }[] = []
  const begin = coordination.beginGitHubTaskRead
  const beginSpy = vi.spyOn(coordination, 'beginGitHubTaskRead').mockImplementation((...args) => {
    const read = begin(...args),
      record = { id: reads.length + 1, disposed: false, marks: 0, applications: [] as unknown[] }
    reads.push(record)
    const apply = read.apply,
      mark = read.mark,
      dispose = read.dispose
    console.info('R5-TITLE-READ-BEGIN', JSON.stringify({ id: record.id, sources: args[0] }))
    readSpies.push(
      vi.spyOn(read, 'apply').mockImplementation((...input) => {
        const result = apply(...input)
        const observation = {
          id: record.id,
          input: input[0].map(describe),
          current: input[1]?.map(describe),
          result: result.map(describe)
        }
        record.applications.push(observation)
        console.info('R5-TITLE-READ-APPLY', JSON.stringify(observation))
        return result
      }),
      vi.spyOn(read, 'mark').mockImplementation((...input) => {
        record.marks += 1
        console.info(
          'R5-TITLE-READ-MARK',
          JSON.stringify({
            id: record.id,
            target: input[0].key,
            current: input[0].current(),
            item: describe(input[1])
          })
        )
        return mark(...input)
      }),
      vi.spyOn(read, 'dispose').mockImplementation(() => {
        record.disposed = true
        console.info('R5-TITLE-READ-DISPOSE', record.id)
        return dispose()
      })
    )
    return read
  })
  const nativeButton = () =>
    container.querySelector<HTMLButtonElement>(
      '[data-native-issue="https://github.com/o/r/issues/5"]'
    )
  const snapshot = (stage: string) => {
    console.info(
      'R5-TITLE-STAGE',
      JSON.stringify({
        stage,
        now: Date.now(),
        bucket,
        cache: store.getState().workItemsCache[bucket],
        pages: context.pages.map((page) => page?.map(describe)),
        details: [...workItemDetailsCache.entries()].map(([key, entry]) => ({
          key,
          details: entry.details
        })),
        dialogTitle: container.querySelector('h1')?.textContent,
        smart: model?.githubItems.map(describe),
        nativeTitle: nativeButton()?.textContent,
        selected: selected.mock.calls,
        reads,
        entries: getTaskPageGitHubListEntries().size,
        pending: getTaskPageGitHubPendingEntries().size,
        listCalls: list.mock.calls,
        directCalls: direct.mock.calls,
        updateCalls: update.mock.calls,
        current: isGitHubTaskObservationCurrent(owner, store.getState().repos[0]),
        sameRepos: store.getState().repos === registeredRepos,
        sameSource: model?.githubSourceContext === source
      })
    )
    expect(store.getState().workItemsCache[initialCacheKey].data![1]).toBe(foreign)
    expect(JSON.stringify(foreign)).toBe(foreignData)
    expect(store.getState().workItemsCache[bucket].data![1]).toBe(seededCache[1])
    expect(JSON.stringify(admitted[1])).toBe(neighborData)
  }
  try {
    await mount(false, outputs, query, true)
    expect(direct).toHaveBeenCalledTimes(1)
    expect(store.getState().workItemsCache[bucket].data).toBe(seededCache)
    expect(Date.now() - store.getState().workItemsCache[bucket].fetchedAt).toBeGreaterThan(
      WORK_ITEMS_CACHE_TTL
    )
    snapshot('registered leaf seeded Old; bucket expired but present; dialog mounted')
    const accepted =
      Promise.withResolvers<
        NonNullable<Awaited<ReturnType<typeof window.api.gh.workItemDetails>>>
      >()
    direct.mockReturnValueOnce(accepted.promise)
    await click()
    expect(direct).toHaveBeenCalledTimes(2)
    expect(direct.mock.calls[1][0]).toMatchObject({
      repoId: repo.id,
      sourceContext: source,
      ownerRepo: { owner: 'o', repo: 'r', host: 'github.com' }
    })
    const stale = Promise.withResolvers<{ items: GitHubWorkItem[]; sources: typeof sources }>()
    list.mockReturnValueOnce(stale.promise)
    smartEnabled = true
    await mount(false, outputs, query, true)
    snapshot('Old prepaint committed; smart and leaf reads live; DIRECT and list held')
    expect(list).toHaveBeenCalledTimes(2)
    expect(reads).toHaveLength(1)
    expect(reads.every((read) => !read.disposed)).toBe(true)
    expect(nativeButton()?.textContent).toBe('#5 Old')
    await act(async () => {
      accepted.resolve({ item: { ...old, title: 'New' }, body: 'New body', comments: [] })
    })
    snapshot('DIRECT New accepted; exact bucket/dialog New; smart local Old; list still held')
    expect(store.getState().workItemsCache[bucket].data![0].title).toBe('New')
    expect(container.querySelector('h1')?.textContent).toBe('New#5')
    expect(container.querySelector('[data-body]')?.textContent).toBe('New body')
    expect(model?.githubItems[0].title).toBe('New')
    expect(reads.map((read) => read.marks)).toEqual([1])
    expect(reads.every((read) => !read.disposed)).toBe(true)
    await act(async () => {
      stale.resolve({ items: [old, neighbor], sources })
    })
    snapshot('provider list Old released; actual leaf/smart reconcile and native render settled')
    await act(async () => {
      nativeButton()!.click()
    })
    snapshot('real row selection called once with the whole visible item')
    expect(selected).toHaveBeenCalledTimes(1)
    expect(selected.mock.calls[0][0]).toBe(model?.githubItems[0])
    expect(reads).toHaveLength(1)
    expect(reads.every((read) => read.disposed)).toBe(true)
    expect(store.getState().repos).toBe(registeredRepos)
    expect(model?.githubSourceContext).toBe(source)
    expect(isGitHubTaskObservationCurrent(owner, store.getState().repos[0])).toBe(true)
    expect(list).toHaveBeenCalledTimes(2)
    expect(direct).toHaveBeenCalledTimes(2)
    expect(update).not.toHaveBeenCalled()
    expect(getTaskPageGitHubListEntries().size).toBe(0)
    expect(getTaskPageGitHubPendingEntries().size).toBe(0)
    expect(store.getState().workItemsCache[bucket].data![0].title).toBe('New')
    expect(container.querySelector('h1')?.textContent).toBe('New#5')
    expect
      .soft(nativeButton()?.textContent, 'native title after accepted DIRECT and stale list')
      .toBe('#5 New')
    expect
      .soft(selected.mock.calls[0][0].title, 'whole callback from the same visible row')
      .toBe('New')
  } finally {
    for (const spy of readSpies) {
      spy.mockRestore()
    }
    beginSpy.mockRestore()
    clock.mockRestore()
  }
})

it('delivers one current CmdJ wrapper and nested issue through real search, DIRECT and activation', async () => {
  const { click } = await import('./github-task-refresh.test-fixture')
  const { useWorktreeJumpPaletteTaskSearch } =
    await import('@/components/use-worktree-jump-palette-task-search')
  const { openCmdJTask } = await import('@/components/cmd-j/task-search-activation')
  const { EMPTY_PALETTE_FILTER } = await import('@/components/cmd-j/palette-filter')
  const { buildPaletteFilterModel } = await import('@/components/cmd-j/palette-filter-options')
  const { createGlobalSettingsFixture } =
    await import('../../../shared/global-settings-test-fixture')
  const old = { ...seed, title: 'Palette Old' }
  direct.mockResolvedValueOnce({ item: old, body: 'Old body', comments: [] })
  const held = Promise.withResolvers<{
    items: GitHubWorkItem[]
    sources: { issues: null; prs: null }
  }>()
  list.mockReturnValueOnce(held.promise)
  const closeModal = vi.fn(),
    openTaskPage = vi.fn()
  store.setState({
    closeModal,
    openTaskPage,
    preflightStatus: {
      git: { installed: true },
      gh: { installed: true, authenticated: true },
      glab: { installed: false, authenticated: false }
    },
    preflightStatusChecked: true
  })
  const settings = createGlobalSettingsFixture({ visibleTaskProviders: ['github'] })
  const input = {
    visible: true,
    query: 'palette',
    repos: store.getState().repos,
    settings,
    filter: EMPTY_PALETTE_FILTER,
    hostOptions: [],
    defaultHostId: 'local' as const,
    filterModel: buildPaletteFilterModel({
      repos: store.getState().repos,
      worktrees: [],
      hostOptions: [],
      projects: [],
      projectHostSetups: [],
      defaultHostId: 'local'
    })
  }
  let result: ReturnType<typeof useWorktreeJumpPaletteTaskSearch> | undefined
  function Palette() {
    const current = useWorktreeJumpPaletteTaskSearch(input)
    React.useLayoutEffect(() => {
      result = current
    })
    return (
      <section data-palette>
        {current.taskItems.map(({ id, result }) => (
          <button key={id} onClick={() => openCmdJTask(result)}>
            {result.title}
          </button>
        ))}
      </section>
    )
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await mount(false, () => <Palette />)
    await act(async () => vi.advanceTimersByTimeAsync(600))
    expect(list).toHaveBeenCalledTimes(1)
    direct.mockResolvedValueOnce({
      item: { ...old, title: 'Palette New' },
      body: 'New body',
      comments: []
    })
    await click()
    await act(async () => held.resolve({ items: [old], sources: { issues: null, prs: null } }))
    expect(result?.taskItems).toHaveLength(1)
    const visible = result!.taskItems[0].result
    expect(visible.title).toBe('Palette New')
    expect(visible.task.issue.title).toBe('Palette New')
    expect(container.querySelector('[data-palette] button')?.textContent).toBe('Palette New')
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-palette] button')!.click()
    )
    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(openTaskPage).toHaveBeenCalledWith(
      expect.objectContaining({
        openGitHubWorkItem: visible.task.issue,
        openGitHubSourceContext: visible.sourceContext
      }),
      { recordTasksInteraction: false }
    )
    expect(openTaskPage.mock.calls[0][0].openGitHubWorkItem).toBe(visible.task.issue)
    expect(list).toHaveBeenCalledTimes(1)
    expect(direct).toHaveBeenCalledTimes(2)
    expect(update).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('keeps two useful no-install returns in their own committed destinations after semantic cache deletion', async () => {
  const { beginGitHubTaskRead } = await import('@/store/github/request-coordination')
  const { useGitHubTaskDeliveryState } = await import('@/hooks/useGitHubTaskDeliveryState')
  const reads = [0, 1].map(() =>
    beginGitHubTaskRead(
      [{ repoId: repo.id, path: repo.path, sourceContext: source }],
      undefined,
      store.getState()
    )
  )
  const disposed = reads.map((read) => vi.spyOn(read, 'dispose'))
  const destinations: React.Dispatch<React.SetStateAction<GitHubWorkItem[]>>[] = []
  const rows: GitHubWorkItem[][] = []
  function Owner({ index }: { index: number }) {
    const [items, setItems] = useGitHubTaskDeliveryState<GitHubWorkItem[]>([])
    React.useLayoutEffect(() => {
      destinations[index] = setItems
      rows[index] = items
    }, [items, setItems, index])
    return <div data-return-owner={index}>{items.map((item) => item.title).join(',')}</div>
  }
  await mount(false, () => (
    <>
      <Owner index={0} />
      <Owner index={1} />
    </>
  ))
  const held = Promise.withResolvers<{
    items: GitHubWorkItem[]
    sources: { issues: null; prs: null }
  }>()
  list.mockReturnValueOnce(held.promise)
  const returns = reads.map((taskRead) =>
    store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 12, 'cold-return', { sourceContext: source, taskRead })
  )
  await act(async () => store.getState().evictGitHubRepoCaches(repo.id, repo.path))
  await act(async () => {
    held.resolve({
      items: [{ ...seed, title: 'Useful uncached return' }],
      sources: { issues: null, prs: null }
    })
    const results = await Promise.all(returns)
    results.forEach((items, index) => {
      reads[index].deliver(items, destinations[index])
      reads[index].finish()
    })
  })
  expect(list).toHaveBeenCalledTimes(1)
  expect(disposed.every((spy) => spy.mock.calls.length === 1)).toBe(true)
  expect(Object.keys(store.getState().workItemsCache)).toHaveLength(0)
  expect(rows.map((items) => items[0].title)).toEqual([
    'Useful uncached return',
    'Useful uncached return'
  ])
  await act(async () => store.getState().evictGitHubRepoCaches(repo.id, repo.path))
  expect(
    [...container.querySelectorAll('[data-return-owner]')].map((node) => node.textContent)
  ).toEqual(['Useful uncached return', 'Useful uncached return'])
  disposed.forEach((spy) => spy.mockRestore())
})

it('keeps accepted New through a mounted nonempty query transition to a cold destination', async () => {
  const { click } = await import('./github-task-refresh.test-fixture')
  const { useSmartWorkspaceNameFieldController } =
    await import('@/components/new-workspace/use-smart-workspace-name-field-controller')
  const { RowLabel } = await import('@/components/new-workspace/smart-workspace-source-row-content')
  const coordination = await import('@/store/github/request-coordination')
  const { getLocalPreflightContext, localPreflightContextKey } =
    await import('@/lib/local-preflight-context')
  const { workItemsCacheKey } = await import('@/store/github/cache-identity')
  const { getTaskSourceCacheScope } = await import('../../../shared/task-source-context')
  const old = { ...seed, id: 'issue:5', title: 'Old', labels: ['bug'] }
  const sources = { issues: { owner: 'o', repo: 'r' }, prs: null }
  const q1 = 'is:open',
    q2 = 'is:open label:bug'
  const bucket = (query: string) =>
    workItemsCacheKey(repo.id, 12, query, getTaskSourceCacheScope(source))
  const registeredRepos = store.getState().repos
  const foreign = store.getState().workItemsCache[initialCacheKey].data![1]
  const foreignBytes = JSON.stringify(foreign)
  const selected = vi.fn(),
    noop = () => {}
  let query = q1
  let model: ReturnType<typeof useSmartWorkspaceNameFieldController> | undefined
  const props = {
    repos: registeredRepos,
    repoId: repo.id,
    selectedRepo: repo,
    githubSourceContext: source,
    branchesEnabled: false,
    onRepoChange: noop,
    onValueChange: noop,
    onGitHubItemSelect: selected,
    onBranchSelect: noop,
    onLinearIssueSelect: noop,
    selectedSource: null,
    onClearSelectedSource: noop
  }
  function Smart() {
    const current = useSmartWorkspaceNameFieldController({ ...props, value: query })
    React.useLayoutEffect(() => {
      model = current
    })
    return (
      <section data-cold-smart>
        {current.rows
          .filter((row) => row.kind === 'github')
          .map((row) => (
            <button
              key={row.value}
              data-cold-issue={row.item.url}
              onClick={() => current.handleSelect(row)}
            >
              <RowLabel row={row} />
            </button>
          ))}
      </section>
    )
  }
  const outputs = () => <Smart />
  const button = () =>
    container.querySelector<HTMLButtonElement>(
      '[data-cold-issue="https://github.com/o/r/issues/5"]'
    )
  const reads: { marks: number; disposed: boolean }[] = []
  const observations: { mockRestore: () => void }[] = []
  const begin = coordination.beginGitHubTaskRead
  const beginSpy = vi.spyOn(coordination, 'beginGitHubTaskRead').mockImplementation((...args) => {
    const read = begin(...args),
      record = { marks: 0, disposed: false }
    reads.push(record)
    const mark = read.mark,
      dispose = read.dispose,
      deliver = read.deliver
    observations.push(
      vi.spyOn(read, 'mark').mockImplementation((...input) => {
        record.marks++
        return mark(...input)
      }),
      vi.spyOn(read, 'dispose').mockImplementation(() => {
        record.disposed = true
        return dispose()
      }),
      vi.spyOn(read, 'deliver').mockImplementation((items, destination) =>
        deliver(items, (update) =>
          destination(
            Object.assign((current: GitHubWorkItem[]) => {
              const result = update(current)
              console.info('RESIDUAL-TRANSITION', JSON.stringify({ input: items, current, result }))
              return result
            }, update)
          )
        )
      )
    )
    return read
  })
  const snapshot = (stage: string) =>
    console.info(
      'RESIDUAL-STAGE',
      JSON.stringify({
        stage,
        query,
        smart: model?.githubItems,
        native: button()?.textContent,
        q1: store.getState().workItemsCache[bucket(q1)],
        q2: store.getState().workItemsCache[bucket(q2)],
        dialog: container.querySelector('h1')?.textContent,
        reads,
        listCalls: list.mock.calls,
        directCalls: direct.mock.calls,
        selected: selected.mock.calls
      })
    )
  Object.assign(window.api, {
    linear: { status: vi.fn().mockResolvedValue({ connected: false, viewer: null }) }
  })
  store.setState({
    preflightStatus: {
      git: { installed: true },
      gh: { installed: true, authenticated: true },
      glab: { installed: false, authenticated: false }
    },
    preflightStatusChecked: true,
    preflightStatusContextKey: localPreflightContextKey(getLocalPreflightContext(store.getState()))
  })
  direct.mockResolvedValueOnce({ item: old, body: 'Old body', comments: [] })
  list.mockResolvedValueOnce({ items: [old], sources })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await mount(false, outputs, q1, true)
    expect(list).toHaveBeenCalledTimes(1)
    expect(button()?.textContent).toBe('#5 Old')
    expect(reads).toEqual([{ marks: 0, disposed: true }])
    const retained = model!.githubItems[0]
    snapshot('Q1 Old completed and committed')
    const pending = Promise.withResolvers<{ items: GitHubWorkItem[]; sources: typeof sources }>()
    list.mockReturnValueOnce(pending.promise)
    query = q2
    await mount(false, outputs, q1, true)
    await act(async () => vi.advanceTimersByTimeAsync(600))
    expect(list).toHaveBeenCalledTimes(2)
    expect(store.getState().workItemsCache[bucket(q2)]).toBeUndefined()
    expect(model!.githubItems[0]).toBe(retained)
    expect(reads).toEqual([
      { marks: 0, disposed: true },
      { marks: 0, disposed: false }
    ])
    snapshot('same mounted Q2 cold; Q1 Old retained; real transport held')
    direct.mockResolvedValueOnce({ item: { ...old, title: 'New' }, body: 'New body', comments: [] })
    await click()
    expect(container.querySelector('h1')?.textContent).toBe('New#5')
    expect(store.getState().workItemsCache[bucket(q1)].data![0].title).toBe('New')
    expect(store.getState().workItemsCache[bucket(q2)]).toBeUndefined()
    expect(model!.githubItems[0]).toBe(retained)
    expect(reads[1]).toEqual({ marks: 1, disposed: false })
    snapshot('DIRECT New accepted while Q2 pending; retained Old is pre-acquisition')
    await act(async () => pending.resolve({ items: [{ ...old, title: 'New' }], sources }))
    await act(async () => button()!.click())
    snapshot('provider New returned; native row and SAME whole selection consumed')
    expect(reads[1]).toEqual({ marks: 1, disposed: true })
    expect(list).toHaveBeenCalledTimes(2)
    expect(direct).toHaveBeenCalledTimes(2)
    expect(update).not.toHaveBeenCalled()
    expect(store.getState().repos).toBe(registeredRepos)
    expect(model?.githubSourceContext).toBe(source)
    expect(store.getState().workItemsCache[initialCacheKey].data![1]).toBe(foreign)
    expect(JSON.stringify(foreign)).toBe(foreignBytes)
    expect(store.getState().workItemsCache[bucket(q2)].data![0].title).toBe('New')
    expect(selected).toHaveBeenCalledTimes(1)
    expect(selected.mock.calls[0][0]).toBe(model!.githubItems[0])
    expect.soft(button()?.textContent, 'native title after cold Q2 return').toBe('#5 New')
    expect
      .soft(selected.mock.calls[0][0].title, 'SAME whole callback after cold Q2 return')
      .toBe('New')
  } finally {
    observations.forEach((spy) => spy.mockRestore())
    beginSpy.mockRestore()
    vi.useRealTimers()
  }
})
