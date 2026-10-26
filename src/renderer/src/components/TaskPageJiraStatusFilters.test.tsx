// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskPageJiraStatusFilters } from './TaskPageJiraStatusFilters'
import { getJiraStatusCatalogScopeKey } from './task-page-jira-status-catalog'
import type { TaskPageComposerActionsModel } from './task-page/use-task-page-composer-actions'
afterEach(cleanup)
function model(): TaskPageComposerActionsModel {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every field read by the status-controls component.
  return {
    jiraProjectFilter: null,
    jiraHasWorkspace: false,
    selectedJiraStatuses: ['Developed'],
    selectJiraStatuses: vi.fn().mockResolvedValue(undefined),
    jiraQuickFiltersReady: true,
    jiraQuickFiltersPending: false,
    jiraQuickFiltersLoading: false,
    jiraQuickFiltersError: null,
    retryJiraQuickFilters: vi.fn(),
    jiraStatusCatalog: null,
    jiraTaskSourceScopeKey: 'jira-owner',
    selectedJiraSiteId: 'site',
    activeJiraPreset: 'assigned',
    jiraCurrentSprint: false,
    jiraSearchInput: '',
    setJiraSearchInput: vi.fn(),
    setAppliedJiraSearch: vi.fn(),
    clearJiraSavedFilterSelection: vi.fn().mockResolvedValue(undefined),
    jiraSavedFiltersPending: false
  } as unknown as TaskPageComposerActionsModel
}
it('keeps a selected status and reachable Clear when the loaded catalog is empty', () => {
  const state = model()
  render(<TaskPageJiraStatusFilters model={state} />)
  expect(screen.getByRole('button', { name: 'Developed' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Clear statuses' }))
  expect(state.selectJiraStatuses).toHaveBeenCalledWith([])
})
it('multi-selects actual statuses and hands the composed query to manual editing', async () => {
  const state = model()
  state.selectedJiraStatuses = ['In Progress']
  state.jiraStatusCatalog = {
    scopeKey: 'jira-owner::site::assigned',
    items: [
      { name: 'Blocked', categoryKey: 'indeterminate' },
      { name: 'In Progress', categoryKey: 'indeterminate' }
    ]
  }
  render(<TaskPageJiraStatusFilters model={state} />)
  fireEvent.click(screen.getByRole('button', { name: 'Blocked' }))
  expect(state.selectJiraStatuses).toHaveBeenCalledWith(['In Progress', 'Blocked'])
  fireEvent.click(screen.getByRole('button', { name: 'Edit as JQL' }))
  await waitFor(() =>
    expect(state.setJiraSearchInput).toHaveBeenCalledWith(
      'assignee = currentUser() AND statusCategory != Done AND status in ("In Progress") ORDER BY updated DESC'
    )
  )
  expect(state.setAppliedJiraSearch).toHaveBeenCalledWith(
    'assignee = currentUser() AND statusCategory != Done AND status in ("In Progress") ORDER BY updated DESC'
  )
})
it('hides status controls and preserves an existing manual query', () => {
  const state = model()
  state.jiraSearchInput = 'project = CUSTOM ORDER BY created ASC'
  render(<TaskPageJiraStatusFilters model={state} />)
  expect(screen.queryByRole('button', { name: 'Developed' })).toBeNull()
  expect(screen.getByText(/Status filters apply to preset views/)).toBeDefined()
  expect(state.setJiraSearchInput).not.toHaveBeenCalled()
})
it.each([true, false])(
  'keeps current-sprint selection %s in the preview and Edit as JQL query',
  async (currentSprint) => {
    const state = model()
    state.activeJiraPreset = 'all'
    state.selectedJiraStatuses = ['Blocked']
    state.jiraCurrentSprint = currentSprint
    const sprintClause = currentSprint ? ' AND sprint in openSprints()' : ''
    const expected = `statusCategory != Done AND status in ("Blocked")${sprintClause} ORDER BY updated DESC`
    render(<TaskPageJiraStatusFilters model={state} />)
    expect(screen.getByRole('textbox', { name: 'Status filter JQL' }).getAttribute('value')).toBe(
      expected
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit as JQL' }))
    await waitFor(() => expect(state.setJiraSearchInput).toHaveBeenCalledWith(expected))
    expect(state.setAppliedJiraSearch).toHaveBeenCalledWith(expected)
  }
)
it('hides statuses and query preview in linked mode without clearing selection', () => {
  const state = model()
  state.jiraHasWorkspace = true
  const { container } = render(<TaskPageJiraStatusFilters model={state} />)
  expect(container.innerHTML).toBe('')
  expect(state.selectJiraStatuses).not.toHaveBeenCalled()
  expect(state.selectedJiraStatuses).toEqual(['Developed'])
})

it.each([false, true])(
  'includes the mapped project and sprint selection %s in manual editing',
  async (currentSprint) => {
    const state = model()
    state.jiraCurrentSprint = currentSprint
    state.jiraProjectFilter = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
    render(<TaskPageJiraStatusFilters model={state} />)
    const sprintClause = currentSprint ? ' AND sprint in openSprints()' : ''
    const query = `project = "10" AND (assignee = currentUser() AND statusCategory != Done AND status in ("Developed")${sprintClause}) ORDER BY updated DESC`
    expect(screen.getByRole('textbox', { name: 'Status filter JQL' }).getAttribute('value')).toBe(
      query
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit as JQL' }))
    await waitFor(() => expect(state.setAppliedJiraSearch).toHaveBeenCalledWith(query))
  }
)

it('drops prior-project discovered statuses while retaining the selected status on project change', () => {
  const state = model()
  state.jiraProjectFilter = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
  state.jiraStatusCatalog = {
    scopeKey: getJiraStatusCatalogScopeKey(
      state.jiraTaskSourceScopeKey,
      state.selectedJiraSiteId,
      state.activeJiraPreset,
      state.jiraProjectFilter
    ),
    items: [{ name: 'Alpha only', categoryKey: 'indeterminate' }]
  }
  const { rerender } = render(<TaskPageJiraStatusFilters model={state} />)
  expect(screen.getByRole('button', { name: 'Alpha only' })).toBeDefined()
  state.jiraProjectFilter = { id: '20', key: 'BET', name: 'Beta', siteId: 'site-b' }
  rerender(<TaskPageJiraStatusFilters model={state} />)
  expect(screen.queryByRole('button', { name: 'Alpha only' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Developed' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(state.selectJiraStatuses).not.toHaveBeenCalled()
})
