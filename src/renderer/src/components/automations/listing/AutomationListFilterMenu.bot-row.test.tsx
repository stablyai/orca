// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationListFilterMenu, AutomationListFilterPills } from './AutomationListFilterMenu'
import { botListFilter, type AutomationListFilter } from './automation-list-view'

afterEach(cleanup)

const BOT = { workspaceId: 'folder:fixture-bot', name: 'Fixture Bot', hostId: 'local' } as const
const ROW_NAME = 'Remove Bot filter: Fixture Bot'

function Harness(): React.JSX.Element {
  const [filter, setFilter] = useState<AutomationListFilter>(botListFilter(BOT))
  return (
    <TooltipProvider>
      <AutomationListFilterMenu filter={filter} onChange={setFilter} />
      <AutomationListFilterPills filter={filter} onChange={setFilter} />
    </TooltipProvider>
  )
}

function openMenu(): HTMLElement {
  render(<Harness />)
  const trigger = screen.getByRole('button', { name: 'Filters (1)' })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter' })
  return trigger
}

it('names the Bot row like the pill, as a plain menu item', () => {
  openMenu()
  const row = screen.getByRole('menuitem', { name: ROW_NAME })
  expect(row.getAttribute('aria-label')).toBe(ROW_NAME)
  // The pill's × reads the same, so either place says what it removes (hidden behind the open menu).
  expect(screen.getByRole('button', { name: ROW_NAME, hidden: true })).toBeTruthy()
})

it.each([
  ['Enter', (row: HTMLElement) => fireEvent.keyDown(row, { key: 'Enter' })],
  ['Space', (row: HTMLElement) => fireEvent.keyDown(row, { key: ' ' })],
  ['click', (row: HTMLElement) => fireEvent.click(row)]
])('%s on the Bot row clears the filter, closes the menu and returns focus', async (_, act) => {
  const trigger = openMenu()
  act(screen.getByRole('menuitem', { name: ROW_NAME }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  // Cleared: no pill, no badge count.
  expect(screen.queryByRole('button', { name: ROW_NAME })).toBeNull()
  expect(screen.getByRole('button', { name: 'Filters' })).toBe(trigger)
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})
