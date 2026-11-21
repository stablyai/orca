// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import zh from '@/i18n/locales/zh.json'
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

beforeAll(() => {
  i18n.addResourceBundle('zh', 'translation', zh)
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

  expect(screen.getByText('手动')).toBeTruthy()
  expect(screen.getByText('智能体活动')).toBeTruthy()
  expect(screen.queryByText('Manual')).toBeNull()
})
