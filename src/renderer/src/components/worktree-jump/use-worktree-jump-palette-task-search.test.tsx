// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { useWorktreeJumpPaletteTaskSearch } from './use-worktree-jump-palette-task-search'
import { createCmdJTaskSearchRequests } from '../cmd-j/task-search-requests'
import { jiraTaskResult } from '../cmd-j/task-search.test-fixture'
import { EMPTY_PALETTE_FILTER } from '../cmd-j/palette-filter'
import { buildPaletteFilterModel } from '../cmd-j/palette-filter-options'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { makeCmdJTaskSearchResult } from '../cmd-j/task-search-results'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { buildTaskSourceContextFromRepo } from '../../../../shared/task-source-context'

vi.mock('../cmd-j/task-search-requests', () => ({ createCmdJTaskSearchRequests: vi.fn() }))
const input: Parameters<typeof useWorktreeJumpPaletteTaskSearch>[0] = {
  visible: true,
  query: 'login redirect',
  settings: createGlobalSettingsFixture({ visibleTaskProviders: ['jira'] }),
  repos: [],
  hostOptions: [],
  defaultHostId: 'local',
  filter: EMPTY_PALETTE_FILTER,
  filterModel: buildPaletteFilterModel({
    repos: [],
    worktrees: [],
    hostOptions: [],
    projects: [],
    projectHostSetups: [],
    defaultHostId: 'local'
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(createCmdJTaskSearchRequests).mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('debounces queries without starting the old request and delays loading feedback', async () => {
  const run = vi.fn(() => new Promise<(typeof jiraTaskResult)[]>(() => {}))
  vi.mocked(createCmdJTaskSearchRequests).mockReturnValue([
    { id: 'jira', provider: 'jira', hostLabel: 'Local', run }
  ])
  const { result, rerender } = renderHook(useWorktreeJumpPaletteTaskSearch, { initialProps: input })
  for (const query of ['lo', 'log', 'logi', 'login']) {
    await act(async () => vi.advanceTimersByTimeAsync(350))
    rerender({ ...input, query })
    expect(run).not.toHaveBeenCalled()
    expect(result.current.taskSearchLoading).toBe(false)
  }
  await act(async () => vi.advanceTimersByTimeAsync(599))
  expect(run).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(run).toHaveBeenCalledTimes(1)
  expect(createCmdJTaskSearchRequests).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: 'login' })
  )
  expect(result.current.taskSearchLoading).toBe(false)
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(result.current.taskSearchLoading).toBe(true)
})

it('publishes a fast source while a second is pending, then discards both after close', async () => {
  let complete: (results: (typeof jiraTaskResult)[]) => void = () => {}
  const slow = new Promise<(typeof jiraTaskResult)[]>((resolve) => {
    complete = resolve
  })
  vi.mocked(createCmdJTaskSearchRequests).mockReturnValue([
    { id: 'fast', provider: 'jira', hostLabel: 'Local', run: async () => [jiraTaskResult] },
    { id: 'slow', provider: 'jira', hostLabel: 'Remote', run: () => slow }
  ])
  const { result, rerender } = renderHook(useWorktreeJumpPaletteTaskSearch, { initialProps: input })
  await act(async () => vi.advanceTimersByTimeAsync(600))
  expect(result.current.taskItems.map((item) => item.id)).toEqual([jiraTaskResult.id])
  rerender({ ...input, visible: false })
  await act(async () => complete([{ ...jiraTaskResult, id: 'late' }]))
  expect(result.current.taskItems).toEqual([])
  rerender(input)
  expect(result.current.taskItems).toEqual([])
})

it('cancels old searches and ignores their replies after the captured palette host changes', async () => {
  let finishOldRequest: (results: (typeof jiraTaskResult)[]) => void = () => {}
  const oldRequest = new Promise<(typeof jiraTaskResult)[]>((resolve) => {
    finishOldRequest = resolve
  })
  const run = vi
    .fn<() => Promise<(typeof jiraTaskResult)[]>>()
    .mockReturnValueOnce(oldRequest)
    .mockResolvedValue([{ ...jiraTaskResult, id: 'new-owner-result' }])
  vi.mocked(createCmdJTaskSearchRequests).mockReturnValue([
    { id: 'jira', provider: 'jira', hostLabel: 'Local', run }
  ])
  const { result, rerender } = renderHook(useWorktreeJumpPaletteTaskSearch, { initialProps: input })
  await act(async () => vi.advanceTimersByTimeAsync(600))
  const previousArgs = vi.mocked(createCmdJTaskSearchRequests).mock.calls[0]?.[0]
  expect(previousArgs?.accountBackedTaskSourceHostId).toBe('local')
  rerender({ ...input, defaultHostId: 'runtime:new-owner' })
  expect(previousArgs?.signal.aborted).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(600))
  expect(createCmdJTaskSearchRequests).toHaveBeenLastCalledWith(
    expect.objectContaining({ accountBackedTaskSourceHostId: 'runtime:new-owner' })
  )
  expect(run).toHaveBeenCalledTimes(2)
  await act(async () => finishOldRequest([{ ...jiraTaskResult, id: 'old-owner-result' }]))
  expect(result.current.taskItems.map((item) => item.id)).toEqual(['new-owner-result'])
})

it('shows an accepted GitHub task record over the stale search row it returned', async () => {
  const repo: Repo = { id: 'repo', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 1 }
  const issue: GitHubWorkItem = {
    id: 'issue:42',
    repoId: repo.id,
    type: 'issue',
    number: 42,
    title: 'Indexed',
    state: 'open',
    labels: [],
    assignees: [],
    url: 'https://github.com/acme/widgets/issues/42',
    author: null,
    updatedAt: '2026-10-31T12:00:02Z'
  }
  useAppStore.setState({ repos: [repo] })
  const cache = useAppStore.getState().githubTaskCache
  await cache.readCanonical(issue, cache.capture(repo)!, async () => ({
    ...issue,
    title: 'Accepted',
    labels: ['bug']
  }))
  const source = buildTaskSourceContextFromRepo({ provider: 'github', projectId: repo.id, repo })!
  vi.mocked(createCmdJTaskSearchRequests).mockReturnValue([
    {
      id: 'github',
      provider: 'github',
      hostLabel: 'Local',
      run: async () => [
        makeCmdJTaskSearchResult({ provider: 'github', issue }, source, repo.id, 'Local')
      ]
    }
  ])
  const { result } = renderHook(useWorktreeJumpPaletteTaskSearch, { initialProps: input })
  await act(async () => vi.advanceTimersByTimeAsync(600))
  const task = result.current.taskItems[0]?.result.task
  expect(task?.provider === 'github' && task.issue).toMatchObject({
    title: 'Accepted',
    labels: ['bug']
  })
  useAppStore.setState({ repos: [] })
})

it('filters to open after pending edits apply: a pending reopen shows and a failure removes it', async () => {
  const repo: Repo = { id: 'repo', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 1 }
  const issue = (number: number, state: GitHubWorkItem['state']): GitHubWorkItem => ({
    id: `issue:${number}`,
    repoId: repo.id,
    type: 'issue',
    number,
    title: `#${number}`,
    state,
    labels: [],
    assignees: [],
    url: `https://github.com/acme/widgets/issues/${number}`,
    author: null,
    updatedAt: '2026-10-31T12:00:02Z'
  })
  const closed = issue(42, 'closed'),
    open = issue(43, 'open')
  useAppStore.setState({ repos: [repo] })
  const cache = useAppStore.getState().githubTaskCache
  const binding = cache.capture(repo)!
  const reopen = cache.operation(closed, binding, { state: 'open' })
  const close = cache.operation(open, binding, { state: 'closed' })
  const source = buildTaskSourceContextFromRepo({ provider: 'github', projectId: repo.id, repo })!
  vi.mocked(createCmdJTaskSearchRequests).mockReturnValue([
    {
      id: 'github',
      provider: 'github',
      hostLabel: 'Local',
      run: async () =>
        [closed, open].map((item) =>
          makeCmdJTaskSearchResult({ provider: 'github', issue: item }, source, repo.id, 'Local')
        )
    }
  ])
  const { result } = renderHook(useWorktreeJumpPaletteTaskSearch, { initialProps: input })
  await act(async () => vi.advanceTimersByTimeAsync(600))
  const numbers = () =>
    result.current.taskItems.map(({ result: { task } }) =>
      task.provider === 'github' ? task.issue.number : null
    )
  expect(numbers()).toEqual([42])
  act(() => {
    reopen(false)
    close(false)
  })
  expect(numbers()).toEqual([43])
  useAppStore.setState({ repos: [] })
})

let actualCreateRequests: typeof createCmdJTaskSearchRequests
beforeAll(async () => {
  const actual = await vi.importActual<{
    createCmdJTaskSearchRequests: typeof createCmdJTaskSearchRequests
  }>('../cmd-j/task-search-requests')
  actualCreateRequests = actual.createCmdJTaskSearchRequests
})
it.each([false, true])(
  'answers a GitHub search held by a source save once it settles, or reads nothing once closed (closed=%s)',
  async (closed) => {
    vi.mocked(createCmdJTaskSearchRequests).mockImplementation(actualCreateRequests)
    const repo: Repo = {
      id: 'held-repo',
      path: '/held-repo',
      displayName: 'Held',
      badgeColor: '',
      addedAt: 1,
      executionHostId: 'local'
    }
    const fork = { owner: 'fork', repo: 'project' }
    const listWorkItems = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'issue:12',
          repoId: repo.id,
          type: 'issue',
          number: 12,
          title: 'login redirect',
          state: 'open',
          labels: [],
          assignees: [],
          url: 'https://github.com/fork/project/issues/12',
          author: null,
          updatedAt: '2026-11-01T00:00:00Z'
        }
      ],
      sources: { issues: fork, prs: fork, originCandidate: fork, upstreamCandidate: null }
    })
    const save = Promise.withResolvers<Repo>()
    const apiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { repos: { update: vi.fn(() => save.promise) }, gh: { listWorkItems } }
    })
    useAppStore.setState({ repos: [repo], preflightStatusChecked: false, workItemsCache: {} })
    try {
      const saving = useAppStore
        .getState()
        .setIssueSourcePreference(repo.id, repo.path, 'origin', 'local')
      const props = {
        ...input,
        settings: createGlobalSettingsFixture({ visibleTaskProviders: ['github'] }),
        repos: useAppStore.getState().repos
      }
      const { result, rerender } = renderHook(useWorktreeJumpPaletteTaskSearch, {
        initialProps: props
      })
      await act(async () => vi.advanceTimersByTimeAsync(900))
      expect(listWorkItems).not.toHaveBeenCalled()
      if (closed) {
        rerender({ ...props, visible: false })
      }
      await act(async () => {
        save.resolve({ ...repo, issueSourcePreference: 'origin' })
        await saving
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(listWorkItems).toHaveBeenCalledTimes(closed ? 0 : 1)
      expect(result.current.taskItems).toHaveLength(closed ? 0 : 1)
    } finally {
      useAppStore.setState({ repos: [], workItemsCache: {} })
      if (apiDescriptor) {
        Object.defineProperty(window, 'api', apiDescriptor)
      }
    }
  }
)
