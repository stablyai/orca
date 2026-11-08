// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskPageJiraStatusFilters } from './TaskPageJiraStatusFilters'
import { getJiraStatusCatalogScopeKey } from './task-page-jira-status-catalog'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
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
