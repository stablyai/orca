// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'

import type { Repo } from '../../../../../shared/repo-types'
import { useTaskPageJiraProjectScope } from './use-task-page-jira-project-scope'

const { readSavedFilters, mutateSavedFilters, readQuickFilters, writeQuickFilters } = vi.hoisted(
  () => ({
    readSavedFilters: vi.fn(),
    mutateSavedFilters: vi.fn(),
    readQuickFilters: vi.fn(),
    writeQuickFilters: vi.fn()
  })
)
vi.mock('@/runtime/jira/runtime-jira-saved-filter-state', () => ({
  readJiraSavedFilterState: readSavedFilters,
  mutateJiraSavedFilters: mutateSavedFilters
}))
vi.mock('@/runtime/jira/runtime-jira-quick-filter-state', () => ({
  readJiraQuickFilterState: readQuickFilters,
  writeJiraQuickFilterState: writeQuickFilters
}))
const originalState = useAppStore.getState()
const project = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
const filter = { id: 'saved', name: 'Saved work', jql: 'filter = 12345' }
const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Alpha',
  badgeColor: '',
  addedAt: 0,
  defaultJiraProject: project,
  kind: 'folder'
}
const sshProject = { ...project, id: '20', key: 'BRV', name: 'Bravo' }
const sshRepo: Repo = {
  ...repo,
  path: '/ssh/repo',
  connectionId: 'builder',
  defaultJiraProject: sshProject
}

afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
  localStorage.removeItem('orca.jira.has-workspace.v1')
})
beforeEach(() => {
  vi.resetAllMocks()
  readSavedFilters.mockResolvedValue({ filters: [filter], activeFilterId: filter.id })
  mutateSavedFilters.mockResolvedValue({ filters: [filter], activeFilterId: null })
  readQuickFilters.mockResolvedValue({ statuses: ['Blocked'] })
  writeQuickFilters.mockResolvedValue({ statuses: [] })
})
describe('repository-scoped Jira Tasks', () => {
  it('does not borrow a compatible default when the explicit matching owner uses another account', () => {
    const runtimeRepo: Repo = { ...repo, executionHostId: 'runtime:remote' }
    const { result } = renderHook(() =>
      useTaskPageJiraProjectScope(
        [repo, runtimeRepo],
        [runtimeRepo],
        repo.id,
        'local',
        project.siteId
      )
    )
    expect(result.current.jiraProjectFilter).toBeNull()
  })

  it('resets the All-project override when the same repository ID changes execution owner', () => {
    const initialProps: { selected: readonly Repo[] } = { selected: [repo] }
    const { result, rerender } = renderHook(
      ({ selected }) =>
        useTaskPageJiraProjectScope([repo, sshRepo], selected, undefined, 'local', project.siteId),
      { initialProps }
    )
    expect(result.current.jiraProjectFilter).toEqual(project)
    act(() => result.current.setJiraProjectFilter(null))
    expect(result.current.jiraProjectFilter).toBeNull()
    rerender({ selected: [sshRepo] })
    expect(result.current.jiraProjectFilter).toEqual(sshProject)
  })
})
