// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  TaskResumeState,
  TaskViewPresetId
} from '../../../../shared/ui-chrome/ui-chrome-types'
import { GITHUB_TASK_SEARCH_IDLE_MS } from './github/listing/use-github-task-search-commit'
import { useTaskPageGitHubSearchPagination } from './github/listing/use-task-page-github-search-pagination'
import type { TaskPageGitHubQuietRefreshModel } from './github/refresh/use-task-page-github-quiet-refresh'
import { useTaskPageSearchActions } from './use-task-page-search-actions'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderSearch(query: string) {
  vi.useFakeTimers()
  const resume: TaskResumeState = {}
  const setTaskResumeState = (update: Partial<TaskResumeState>): void => {
    Object.assign(resume, update)
  }
  const hook = renderHook(() => {
    const [taskSearchInput, setTaskSearchInput] = useState(query)
    const [appliedTaskSearch, setAppliedTaskSearch] = useState('is:pr is:open')
    const [activeTaskPreset, setActiveTaskPreset] = useState<TaskViewPresetId | null>(null)
    const githubSearchPersistReadyRef = useRef(false)
    const searchModel = {
      taskSearchInput,
      setTaskSearchInput,
      appliedTaskSearch,
      setAppliedTaskSearch,
      activeTaskPreset,
      setActiveTaskPreset,
      activeGithubTaskKind: 'prs',
      githubSearchPersistReadyRef,
      taskResumeApplied: true,
      setTaskResumeState,
      setTasksFiltering: () => {},
      setTaskRefreshNonce: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hooks only use these fields when the test exercises searches without loading more pages.
    const model = searchModel as unknown as TaskPageGitHubQuietRefreshModel
    useTaskPageGitHubSearchPagination(model)
    return useTaskPageSearchActions(model)
  })
  return { ...hook, resume }
}

it('preserves applied search terms when removing a filter after erasing the draft', () => {
  const { result } = renderSearch('is:pr author:example regression')

  act(() => result.current.handleApplyTaskSearch())
  act(() => result.current.setTaskSearchInput(''))
  act(() => result.current.applyPRFilterChange({ authors: [] }))
  expect(result.current.taskSearchInput).toBe('is:pr regression')
  expect(result.current.appliedTaskSearch).toBe('is:pr regression')

  act(() => vi.advanceTimersByTime(GITHUB_TASK_SEARCH_IDLE_MS))
  expect(result.current.appliedTaskSearch).toBe('is:pr regression')
})

it('preserves unsubmitted edits while applying a filter to the current results', () => {
  const { result } = renderSearch('is:pr is:open author:example')

  act(() => result.current.handleApplyTaskSearch())
  act(() => result.current.setTaskSearchInput('is:pr is:open author:example regression'))
  act(() => result.current.applyPRFilterChange({ authors: [] }))
  expect(result.current.taskSearchInput).toBe('is:pr is:open regression')
  expect(result.current.appliedTaskSearch).toBe('is:pr is:open')
  expect(result.current.activeTaskPreset).toBe('prs')

  act(() => vi.advanceTimersByTime(GITHUB_TASK_SEARCH_IDLE_MS))
  expect(result.current.appliedTaskSearch).toBe('is:pr is:open regression')
  expect(result.current.activeTaskPreset).toBeNull()
})

it('keeps the selected preset when the draft resolves to the same query', () => {
  const { result } = renderSearch('is:pr is:closed author:@me')

  act(() => result.current.handleApplyTaskSearch())
  act(() => result.current.setTaskSearchInput('is:pr is:open author:@me'))
  act(() => result.current.applyPRFilterChange({ state: 'open' }))
  act(() => vi.advanceTimersByTime(GITHUB_TASK_SEARCH_IDLE_MS))

  expect(result.current.appliedTaskSearch).toBe('author:@me is:pr is:open')
  expect(result.current.taskSearchInput).toBe('author:@me is:pr is:open')
  expect(result.current.activeTaskPreset).toBe('my-prs')
})

it('leaves an ordinary unsubmitted draft out of the resume state', () => {
  const { result, resume, unmount } = renderSearch('is:pr author:example')

  act(() => result.current.handleApplyTaskSearch())
  act(() => result.current.setTaskSearchInput('is:pr author:example regression'))
  unmount()

  expect(resume.githubItemsQuery).toBe('is:pr author:example')
})

it('resumes the draft from a filter click when leaving before idle', () => {
  const { result, resume, unmount } = renderSearch('is:pr is:open author:example')

  act(() => result.current.handleApplyTaskSearch())
  act(() => result.current.setTaskSearchInput('is:pr is:open author:example regression'))
  act(() => result.current.applyPRFilterChange({ authors: [] }))
  act(() => result.current.setTaskSearchInput('is:pr is:open another draft'))
  unmount()

  expect(resume.githubItemsQuery).toBe('is:pr is:open regression')
  expect(resume.githubItemsPreset).toBeNull()
})

it('keeps a typed label when the next filter action selects another label', () => {
  const { result } = renderSearch('is:pr is:open author:example')

  act(() => result.current.handleApplyTaskSearch())
  act(() => result.current.setTaskSearchInput('is:pr is:open author:example label:bug'))
  act(() => result.current.applyPRFilterChange({ authors: [] }))
  act(() =>
    result.current.applyPRFilterChange({
      selection: { qualifier: 'labels', value: 'enhancement', selected: true }
    })
  )

  expect(result.current.appliedTaskSearch).toBe('is:pr is:open label:enhancement')
  expect(result.current.taskSearchInput).toBe('is:pr is:open label:bug label:enhancement')
  act(() => vi.advanceTimersByTime(GITHUB_TASK_SEARCH_IDLE_MS))
  expect(result.current.appliedTaskSearch).toBe('is:pr is:open label:bug label:enhancement')
})

it('persists the preset selected by a pending filter query after idle', () => {
  const { result, resume } = renderSearch('is:pr is:open author:example label:bug')

  act(() => result.current.handleApplyTaskSearch())
  act(() => result.current.setTaskSearchInput('is:pr is:open author:@me label:bug'))
  act(() => result.current.applyPRFilterChange({ labels: [] }))
  act(() => vi.advanceTimersByTime(GITHUB_TASK_SEARCH_IDLE_MS))

  expect(resume).toEqual({
    githubItemsQuery: 'author:@me is:pr is:open',
    githubItemsPreset: 'my-prs'
  })
})

it.each([
  {
    qualifier: 'authors',
    value: 'example',
    applied: 'is:pr author:example',
    draft: 'is:pr author:Example author:sample-dev',
    expected: 'is:pr author:sample-dev'
  },
  {
    qualifier: 'labels',
    value: 'bug',
    applied: 'is:pr label:bug',
    draft: 'is:pr label:BUG label:enhancement regression',
    expected: 'is:pr label:enhancement regression'
  }
] as const)('removes a case-variant $qualifier filter from the draft', (test) => {
  const { result } = renderSearch(test.applied)

  act(() => result.current.handleApplyTaskSearch())
  act(() => result.current.setTaskSearchInput(test.draft))
  act(() =>
    result.current.applyPRFilterChange({
      selection: { qualifier: test.qualifier, value: test.value, selected: false }
    })
  )
  act(() => vi.advanceTimersByTime(GITHUB_TASK_SEARCH_IDLE_MS))

  expect(result.current.appliedTaskSearch).toBe(test.expected)
})
