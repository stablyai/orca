// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import SidebarAgentsList from './SidebarAgentsList'

vi.mock('@/components/activity/activity-thread-list-pane', () => ({
  ActivityThreadListPane: () => null
}))

beforeEach(() => {
  useAppStore.setState({ agentsShowSearch: true })
  vi.stubGlobal('api', { ui: { set: vi.fn().mockResolvedValue(undefined) } })
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('preserves workspace focus on mount and focuses search only when explicitly enabled', async () => {
  const workspaceInput = document.createElement('input')
  const optionsTarget = document.createElement('div')
  document.body.append(workspaceInput, optionsTarget)
  workspaceInput.focus()
  const setQuery = vi.fn()
  const view = render(
    <TooltipProvider>
      <SidebarAgentsList
        readFilter="all"
        setReadFilter={vi.fn()}
        groupBy="status"
        setGroupBy={vi.fn()}
        query=""
        setQuery={setQuery}
        optionsTarget={optionsTarget}
      />
    </TooltipProvider>
  )

  expect(view.getByRole('textbox', { name: 'Search' })).toBeTruthy()
  expect(document.activeElement).toBe(workspaceInput)

  fireEvent.keyDown(view.getByRole('textbox', { name: 'Search' }), { key: 'Escape' })
  expect(useAppStore.getState().agentsShowSearch).toBe(false)
  expect(setQuery).toHaveBeenCalledWith('')
  expect(view.queryByRole('textbox', { name: 'Search' })).toBeNull()

  await act(async () => {
    fireEvent.keyDown(view.getByRole('button', { name: 'Thread list options' }), { key: 'Enter' })
  })
  await act(async () => {
    fireEvent.keyDown(view.getByRole('menuitemcheckbox', { name: 'Show search' }), { key: 'Enter' })
  })
  await waitFor(() => {
    expect(document.activeElement).toBe(view.getByRole('textbox', { name: 'Search' }))
  })
  expect(useAppStore.getState().agentsShowSearch).toBe(true)
  expect(window.api.ui.set).toHaveBeenCalledWith({ agentsShowSearch: false })
  expect(window.api.ui.set).toHaveBeenCalledWith({ agentsShowSearch: true })
})
