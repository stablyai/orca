// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AccountSwitchList, type AccountSwitchListRow } from './AccountSwitchList'

afterEach(cleanup)

function row(index: number): AccountSwitchListRow {
  return {
    key: String(index),
    email: `account${index}@example.com`,
    workspace: null,
    identifier: null,
    usage: { kind: 'none' },
    needsSignIn: false,
    title: `Account ${index}`,
    active: false,
    disabled: false,
    isFetching: false,
    statusLabel: null,
    hint: null,
    signIn: null,
    onSelect: vi.fn()
  }
}

function renderList(rows: AccountSwitchListRow[], asSubmenu = false): void {
  const content = (
    <>
      <AccountSwitchList heading="Switch account" rows={rows} display="used" />
      <DropdownMenuItem>Manage Accounts</DropdownMenuItem>
    </>
  )
  render(
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger>Accounts</DropdownMenuTrigger>
      <DropdownMenuContent>
        {asSubmenu ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Provider</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>{content}</DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          content
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

describe('account picker with real Radix keyboard handling', () => {
  it.each([false, true])('navigates sort, search and results (submenu: %s)', async (asSubmenu) => {
    const rows = Array.from({ length: 9 }, (_, index) => row(index))
    renderList(rows, asSubmenu)
    if (asSubmenu) {
      const provider = await screen.findByRole('menuitem', { name: 'Provider' })
      provider.focus()
      fireEvent.keyDown(provider, { key: 'ArrowRight' })
    }
    const sort = await screen.findByRole('menuitemradio', { name: 'Least used' })
    sort.focus()
    fireEvent.keyDown(sort, { key: 'Enter' })
    expect(sort.getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(sort, { key: 'ArrowDown' })
    const search = screen.getByRole('textbox', { name: 'Filter accounts' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    expect(fireEvent.keyDown(search, { key: ' ' })).toBe(true)
    fireEvent.change(search, { target: { value: 'account7' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const result = screen.getByTitle('Account 7')
    await waitFor(() => expect(document.activeElement).toBe(result))
    fireEvent.keyDown(result, { key: 'Enter' })
    expect(rows[7].onSelect).toHaveBeenCalledOnce()
    expect(screen.getAllByRole('menu').length).toBeGreaterThan(0)
    search.focus()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(rows[7].onSelect).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('reauthenticates an active row on Enter without switching accounts', async () => {
    const active = {
      ...row(0),
      active: true,
      needsSignIn: true,
      signIn: { disabled: false, isSigningIn: false, onSignIn: vi.fn() }
    }
    renderList([active])
    const item = await screen.findByTitle('Account 0')
    item.focus()
    fireEvent.keyDown(item, { key: 'Enter' })
    expect(active.signIn.onSignIn).toHaveBeenCalledOnce()
    expect(active.onSelect).not.toHaveBeenCalled()
  })
})
