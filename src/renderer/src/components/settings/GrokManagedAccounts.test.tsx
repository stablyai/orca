// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GrokManagedAccounts } from './GrokManagedAccounts'
import type { GrokAccountsState } from '../../../../shared/grok-account-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))
const list = vi.fn()
const select = vi.fn()
const add = vi.fn()
const cancelLogin = vi.fn()
const state: GrokAccountsState = {
  accounts: [
    { id: 'alice', email: 'alice@example.com', userId: 'a', teamId: null },
    { id: 'bob', email: 'bob@example.com', userId: 'b', teamId: null }
  ],
  activeAccountId: 'alice',
  usage: {
    alice: {
      provider: 'grok',
      session: null,
      weekly: {
        usedPercent: 16,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: 'Tuesday'
      },
      status: 'ok',
      updatedAt: 1,
      error: null
    },
    bob: {
      provider: 'grok',
      session: null,
      weekly: { usedPercent: 12, windowMinutes: 10080, resetsAt: null, resetDescription: 'Friday' },
      status: 'ok',
      updatedAt: 1,
      error: null
    }
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue(state)
  select.mockResolvedValue({ ...state, activeAccountId: 'bob' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { grokAccounts: { list, select, add, cancelLogin } }
  })
})
afterEach(cleanup)

it('shows independent usage and switches by account ID', async () => {
  render(<GrokManagedAccounts />)
  expect(await screen.findByText('alice@example.com')).toBeVisible()
  expect(screen.getByText(/16% used/)).toBeVisible()
  expect(screen.getByText(/12% used/)).toBeVisible()
  expect(screen.getByText(/Resets Friday/)).toBeVisible()
  expect(screen.getAllByRole('progressbar')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Use account' }))
  await waitFor(() => expect(select).toHaveBeenCalledWith('bob'))
  const bob = screen.getByText('bob@example.com').parentElement?.parentElement
  if (!bob) {
    throw new Error('Missing account row')
  }
  await waitFor(() => expect(within(bob).getByText('Selected')).toBeVisible())
})

it('rejects delayed list results from before an account switch', async () => {
  let finish: ((value: GrokAccountsState) => void) | undefined
  list.mockResolvedValueOnce(state).mockImplementationOnce(
    () =>
      new Promise<GrokAccountsState>((resolve) => {
        finish = resolve
      })
  )
  const view = render(<GrokManagedAccounts updatedAt={1} />)
  await screen.findByText('alice@example.com')
  view.rerender(<GrokManagedAccounts updatedAt={2} />)
  fireEvent.click(screen.getByRole('button', { name: 'Use account' }))
  await waitFor(() => expect(select).toHaveBeenCalledOnce())
  finish?.(state)
  const bob = screen.getByText('bob@example.com').parentElement?.parentElement
  if (!bob) {
    throw new Error('Missing account row')
  }
  await waitFor(() => expect(within(bob).getByText('Selected')).toBeVisible())
})

it('offers cancellation only for its pending sign-in', async () => {
  let finish: ((value: GrokAccountsState) => void) | undefined
  add.mockImplementationOnce(
    () =>
      new Promise<GrokAccountsState>((resolve) => {
        finish = resolve
      })
  )
  render(<GrokManagedAccounts />)
  await screen.findByText('alice@example.com')
  fireEvent.click(screen.getByRole('button', { name: 'Add Grok account' }))
  expect(screen.getByRole('status')).toHaveTextContent('Complete Grok sign-in')
  expect(screen.getByRole('button', { name: 'Use account' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
  expect(cancelLogin).toHaveBeenCalledOnce()
  finish?.(state)
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
})
