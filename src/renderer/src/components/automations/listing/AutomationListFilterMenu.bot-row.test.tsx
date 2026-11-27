// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { i18n } from '@/i18n/i18n'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'
import { AutomationListFilterMenu, AutomationListFilterPills } from './AutomationListFilterMenu'
import { botListFilter, type AutomationListFilter } from './automation-list-view'

// A sentinel catalog with the name first, as a language that puts it there would.
beforeAll(() => {
  i18n.addResourceBundle(
    'ja',
    'translation',
    {
      auto: {
        components: {
          automations: {
            AutomationListFilterMenu: {
              bot: 'BOT',
              botFilterRowLabel: 'BOT: {{name}} ROW-REMOVE',
              removeBotFilterButton: '{{name}} PILL-REMOVE'
            }
          }
        }
      }
    },
    true,
    true
  )
})

afterAll(() => {
  i18n.removeResourceBundle('ja', 'translation')
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

const BOT = { workspaceId: 'folder:fixture-bot', name: 'Fixture Bot', hostId: 'local' } as const
const ROW_NAME = 'Bot: Fixture Bot, remove filter'
const PILL_X_NAME = 'Remove Bot filter: Fixture Bot'

function Harness(): React.JSX.Element {
  const [filter, setFilter] = useState<AutomationListFilter>(botListFilter(BOT))
  return (
    <TranslationScopeProvider>
      <TooltipProvider>
        <AutomationListFilterMenu filter={filter} onChange={setFilter} />
        <AutomationListFilterPills filter={filter} onChange={setFilter} />
      </TooltipProvider>
    </TranslationScopeProvider>
  )
}

function openMenu(): HTMLElement {
  render(<Harness />)
  const trigger = screen.getByRole('button', { name: 'Filters (1)' })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter' })
  return trigger
}

it('names the Bot row starting with its visible text, as a plain menu item', () => {
  openMenu()
  const row = screen.getByRole('menuitem', { name: ROW_NAME })
  expect(row.textContent).toBe('Bot: Fixture Bot')
  // Label in Name (WCAG 2.5.3): speaking the visible text reaches the row.
  expect(row.getAttribute('aria-label')?.startsWith(row.textContent ?? '')).toBe(true)
  // The pill's × shows no text, so it says what it removes (hidden behind the open menu).
  expect(screen.getByRole('button', { name: PILL_X_NAME, hidden: true })).toBeTruthy()
})

it('takes each name from one translated string, so a language can place the bot name', async () => {
  await act(async () => {
    await i18n.changeLanguage('ja')
  })
  openMenu()
  const row = screen.getByRole('menuitem', { name: 'BOT: Fixture Bot ROW-REMOVE' })
  expect(row.textContent).toBe('BOT: Fixture Bot')
  expect(screen.getByRole('button', { name: 'Fixture Bot PILL-REMOVE', hidden: true })).toBeTruthy()
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
