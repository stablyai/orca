// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'
import { BotSidebarOptionsMenu } from './BotSidebarOptionsMenu'

// Only the menu's own copy matters here, so the popover and rows render inline.
vi.mock('@/components/sidebar/worktree-list/controls/SidebarOptionsPopover', () => ({
  SidebarOptionsPopover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('@/components/sidebar/worktree-list/controls/OptionChoiceSubmenu', () => ({
  OptionChoiceSubmenu: ({ choices }: { choices: { id: string; label: string }[] }) => (
    <ul>
      {choices.map((choice) => (
        <li key={choice.id}>{choice.label}</li>
      ))}
    </ul>
  )
}))
vi.mock('@/components/sidebar/worktree-list/controls/FilterToggleRow', () => ({
  FilterToggleRow: () => null
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => null
}))

// A sentinel catalog stands in for the real one, so only the switch is under test, not its copy.
beforeAll(() => {
  i18n.addResourceBundle(
    'zh',
    'translation',
    { bots: { options: { sortManual: 'switched manual', sortSmart: 'switched smart' } } },
    false,
    true
  )
})

afterAll(() => {
  i18n.removeResourceBundle('zh', 'translation')
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
  vi.unstubAllGlobals()
})

it('the sort choices follow a language switch without remounting', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  render(
    <TranslationScopeProvider>
      <BotSidebarOptionsMenu />
    </TranslationScopeProvider>
  )
  expect(screen.getByText('Manual')).toBeTruthy()

  await act(async () => {
    await i18n.changeLanguage('zh')
  })

  expect(screen.getByText('switched manual')).toBeTruthy()
  expect(screen.getByText('switched smart')).toBeTruthy()
  expect(screen.queryByText('Manual')).toBeNull()
})
