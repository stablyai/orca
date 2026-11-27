// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { i18n } from '@/i18n/i18n'
import zh from '@/i18n/locales/zh.json'
import { AutomationListFilterMenu, AutomationListFilterPills } from './AutomationListFilterMenu'
import { botListFilter, type AutomationListFilter } from './automation-list-view'

const BOT = { workspaceId: 'folder:fixture-bot', name: 'Fixture Bot', hostId: 'local' } as const
const ROW_TEXT = 'Bot: Fixture Bot'
const ROW_NAME = 'Bot: Fixture Bot, remove filter'
const PILL_X_NAME = 'Remove Bot filter: Fixture Bot'

beforeAll(() => {
  i18n.addResourceBundle('zh', 'translation', zh, true, true)
})

afterAll(() => {
  i18n.removeResourceBundle('zh', 'translation')
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

function Harness(): React.JSX.Element {
  const [filter, setFilter] = useState<AutomationListFilter>(botListFilter(BOT))
  return (
    <TooltipProvider>
      <AutomationListFilterMenu filter={filter} onChange={setFilter} />
      <AutomationListFilterPills filter={filter} onChange={setFilter} />
    </TooltipProvider>
  )
}

function openMenu(triggerName = 'Filters (1)'): HTMLElement {
  render(<Harness />)
  const trigger = screen.getByRole('button', { name: triggerName })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter' })
  return trigger
}

it('names the Bot row starting with its visible text, as a plain menu item', () => {
  openMenu()
  const row = screen.getByRole('menuitem', { name: ROW_NAME })
  // Label in name: speech input users say what they see.
  expect(row.textContent).toBe(ROW_TEXT)
  expect(row.getAttribute('aria-label')?.startsWith(row.textContent ?? '\0')).toBe(true)
  // The pill's × has no visible text, so it carries its own name (hidden behind the open menu).
  expect(screen.getByRole('button', { name: PILL_X_NAME, hidden: true })).toBeTruthy()
})

it('takes the row text and both names whole from the catalog, so locale punctuation holds', async () => {
  await i18n.changeLanguage('zh')
  openMenu('筛选条件 (1)')
  const row = screen.getByRole('menuitem', { name: 'Bot：Fixture Bot，移除筛选器' })
  expect(row.textContent).toBe('Bot：Fixture Bot')
  expect(
    screen.getByRole('button', { name: '移除 Bot 筛选器：Fixture Bot', hidden: true })
  ).toBeTruthy()
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
  expect(screen.queryByRole('button', { name: PILL_X_NAME })).toBeNull()
  expect(screen.getByRole('button', { name: 'Filters' })).toBe(trigger)
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})
