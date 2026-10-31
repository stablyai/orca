// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskPageJiraFavouriteFilters } from './TaskPageJiraFavouriteFilters'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { favourite } from '../../__mocks__/task-page-jira-favourite-fixture'

afterEach(cleanup)
it('keeps duplicate names independently searchable and selectable by keyboard', async () => {
  const second = { ...favourite, id: 'fav-2' }
  const apply = vi.fn().mockResolvedValue(true)
  const model = {
    jiraFavouriteFiltersEnabled: true,
    jiraFavouriteFilters: [favourite, second],
    jiraFavouriteFilter: null,
    jiraFavouriteFiltersLoading: false,
    jiraFavouriteFiltersPending: false,
    jiraFavouriteFiltersUnsupported: false,
    jiraFavouriteFiltersTruncated: false,
    jiraFavouriteFiltersError: null,
    retryJiraFavouriteFilters: vi.fn(),
    loadJiraFavouriteFilters: vi.fn(),
    applyJiraFavouriteFilter: apply,
    clearJiraFavouriteFilter: vi.fn(),
    jiraSavedFiltersLoading: false,
    jiraSavedFiltersPending: false,
    jiraSavedFiltersReady: true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This focused surface test supplies every field read by the favourite picker.
  render(<TaskPageJiraFavouriteFilters model={model as unknown as TaskPageComposerActionsModel} />)
  fireEvent.click(screen.getByRole('button', { name: 'Jira favourites' }))
  const input = screen.getByRole('combobox')
  fireEvent.change(input, { target: { value: 'My Jira favourite' } })
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2))
  expect(screen.getByRole('listbox', { name: 'Jira favourites' })).toBeInTheDocument()
  await act(async () => fireEvent.keyDown(input, { key: 'ArrowDown' }))
  await act(async () => fireEvent.keyDown(input, { key: 'ArrowDown' }))
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
  await waitFor(() => expect(apply).toHaveBeenCalledExactlyOnceWith(second))
})

it('offers refresh and clear if a selected favourite’s host becomes unsupported', () => {
  const retry = vi.fn()
  const clear = vi.fn()
  const model = {
    jiraFavouriteFiltersEnabled: true,
    jiraFavouriteFilters: [],
    jiraFavouriteFilter: favourite,
    jiraFavouriteFiltersLoading: false,
    jiraFavouriteFiltersPending: false,
    jiraFavouriteFiltersUnsupported: true,
    jiraFavouriteFiltersTruncated: false,
    jiraFavouriteFiltersError: null,
    retryJiraFavouriteFilters: retry,
    loadJiraFavouriteFilters: vi.fn(),
    applyJiraFavouriteFilter: vi.fn(),
    clearJiraFavouriteFilter: clear,
    jiraSavedFiltersLoading: false,
    jiraSavedFiltersPending: false,
    jiraSavedFiltersReady: true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This focused surface test supplies every field read by the favourite picker.
  render(<TaskPageJiraFavouriteFilters model={model as unknown as TaskPageComposerActionsModel} />)
  fireEvent.click(screen.getByRole('button', { name: `Jira favourites: ${favourite.name}` }))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(retry).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Clear Jira favourite' }))
  expect(clear).toHaveBeenCalledTimes(1)
})
