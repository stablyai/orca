// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
import { buildTaskSourceContextFromRepo } from '../../../../shared/work-items/task-source-context'

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
