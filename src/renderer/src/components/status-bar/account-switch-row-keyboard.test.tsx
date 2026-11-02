// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AccountSwitchList } from './AccountSwitchList'
import { AccountSwitchRowItem } from './AccountSwitchRowItem'
import { InlineUsageSignInAction } from './InlineProviderUsage'

afterEach(cleanup)

it('keeps switching and signing in independent through keyboard and pointer selection', async () => {
  const switchAccount = vi.fn()
  const signIn = vi.fn()
  render(
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger>Accounts</DropdownMenuTrigger>
      <DropdownMenuContent>
        <AccountSwitchList heading="Codex Account">
          <AccountSwitchRowItem
            label="account@example.com"
            active={false}
            onSelect={(event) => {
              event.preventDefault()
              switchAccount()
            }}
            action={
              <InlineUsageSignInAction
                accountLabel="account@example.com"
                isFetching={false}
                isSigningIn={false}
                disabled={false}
                onSignIn={signIn}
              />
            }
          />
        </AccountSwitchList>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  const account = await screen.findByRole('menuitem', { name: 'account@example.com' })
  account.focus()
  fireEvent.keyDown(account, { key: 'Enter' })
  expect(switchAccount).toHaveBeenCalledTimes(1)
  expect(signIn).not.toHaveBeenCalled()

  fireEvent.keyDown(account, { key: 'ArrowDown' })
  const signInAction = screen.getByRole('menuitem', { name: 'Sign in: account@example.com' })
  await waitFor(() => expect(document.activeElement).toBe(signInAction))
  fireEvent.keyDown(signInAction, { key: 'Enter' })
  expect(signIn).toHaveBeenCalledTimes(1)
  expect(switchAccount).toHaveBeenCalledTimes(1)

  fireEvent.click(signInAction)
  expect(signIn).toHaveBeenCalledTimes(2)
  expect(switchAccount).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('menu')).toBeTruthy()
})
