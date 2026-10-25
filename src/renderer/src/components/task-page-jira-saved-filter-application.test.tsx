// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskPageJiraFilters } from './task-page/jira/Filters'
import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import type { JiraSavedFilter } from '../../../shared/jira/jira-saved-filters'
import { TooltipProvider } from './ui/tooltip'

const filter = { id: 'saved', name: 'Saved work', jql: 'project = APP' }
vi.mock('./TaskPageJiraSavedFilters', () => ({
  TaskPageJiraSavedFilters: ({
    onApply
  }: {
    onApply: (filter: JiraSavedFilter) => Promise<void>
  }) => <button onClick={() => void onApply(filter).catch(() => {})}>Apply saved query</button>
}))
afterEach(cleanup)

function setup(apply: (filter: JiraSavedFilter) => Promise<boolean>) {
  const setLinked = vi.fn()
  const model = {
    jiraPresets: [],
    jiraHasWorkspace: true,
    setJiraHasWorkspace: setLinked,
    jiraSearchInput: '',
    jiraSavedFilters: [filter],
    jiraSavedFiltersReady: true,
    applyJiraSavedFilter: apply,
    sortedAvailableJiraProjects: []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The rendered filter header reads only these fields; inactive controls are never invoked.
  const renderedModel = model as unknown as TaskPageComposerActionsModel
  render(
    <TooltipProvider>
      <TaskPageJiraFilters model={renderedModel} />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Apply saved query' }))
  return setLinked
}

it.each([false, true])('leaves linked mode only after successful apply: %s', async (applied) => {
  let settle: (value: boolean) => void = () => {}
  const setLinked = setup(() => new Promise<boolean>((resolve) => (settle = resolve)))
  expect(setLinked).not.toHaveBeenCalled()
  await act(async () => settle(applied))
  if (applied) {
    expect(setLinked).toHaveBeenCalledExactlyOnceWith(false)
  } else {
    expect(setLinked).not.toHaveBeenCalled()
  }
})

it('keeps linked mode when the host rejects application', async () => {
  const apply = vi.fn().mockRejectedValue(new Error('Host disconnected'))
  const setLinked = setup(apply)
  await waitFor(() => expect(apply).toHaveBeenCalledWith(filter))
  expect(setLinked).not.toHaveBeenCalled()
})
