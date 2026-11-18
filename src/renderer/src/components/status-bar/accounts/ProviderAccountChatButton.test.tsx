// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store/index'
import { ProviderAccountChatButton } from './ProviderAccountChatButton'

const local = { kind: 'local' } as const
const openSettingsPage = vi.fn()

beforeEach(() => {
  useAppStore.setState({ openSettingsPage, openSettingsTarget: vi.fn() })
})
afterEach(() => {
  cleanup()
  openSettingsPage.mockReset()
})

function switcher(disabled: boolean) {
  return (
    <TooltipProvider>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <ProviderAccountChatButton provider="claude" target={local} disabled={disabled} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Other account</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

describe('ProviderAccountChatButton', () => {
  it('opens its menu from the keyboard and returns focus on Escape', async () => {
    const user = userEvent.setup()
    render(switcher(false))
    const trigger = screen.getByRole('button', { name: 'Switch account' })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('menuitem', { name: 'Other account' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menuitem', { name: 'Other account' })).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('stays focusable but cannot open while disabled', async () => {
    const user = userEvent.setup()
    render(switcher(true))
    const trigger = screen.getByRole('button', { name: 'Switch account' })
    await user.click(trigger)
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('menuitem', { name: 'Other account' })).toBeNull()
  })

  it('opens account settings to add one, unless disabled', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <TooltipProvider>
        <ProviderAccountChatButton provider="claude" target={local} disabled add />
      </TooltipProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Add account…' }))
    expect(openSettingsPage).not.toHaveBeenCalled()
    rerender(
      <TooltipProvider>
        <ProviderAccountChatButton provider="claude" target={local} disabled={false} add />
      </TooltipProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Add account…' }))
    expect(openSettingsPage).toHaveBeenCalledTimes(1)
  })
})
