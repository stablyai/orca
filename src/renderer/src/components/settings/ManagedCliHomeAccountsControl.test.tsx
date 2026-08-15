// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagedCliHomeAccountsControl } from './ManagedCliHomeAccountsControl'

const grokApi = {
  list: vi.fn(),
  import: vi.fn(),
  select: vi.fn(),
  remove: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  grokApi.list.mockResolvedValue({
    accounts: [
      {
        id: 'grok-a',
        provider: 'grok',
        label: 'Work',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ],
    activeAccountId: 'grok-a'
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      grokAccounts: grokApi,
      geminiAccounts: grokApi
    }
  })
})

afterEach(() => cleanup())

describe('ManagedCliHomeAccountsControl', () => {
  it('renders path-free account summaries and the active selection', async () => {
    render(<ManagedCliHomeAccountsControl provider="grok" />)

    expect(await screen.findByText('Work')).toBeInTheDocument()
    expect(screen.getAllByText('Active')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('managedHomePath')
  })

  it('disables account actions until the initial list resolves', async () => {
    let resolveList: ((value: { accounts: unknown[]; activeAccountId: string }) => void) | undefined
    grokApi.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve
        })
    )

    render(<ManagedCliHomeAccountsControl provider="grok" />)
    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Personal' } })
    expect(screen.getByRole('button', { name: 'Choose home…' })).toBeDisabled()

    resolveList?.({
      accounts: [
        {
          id: 'grok-a',
          provider: 'grok',
          label: 'Work',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeAccountId: 'grok-a'
    })
    expect(await screen.findByText('Work')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose home…' })).toBeEnabled()
  })

  it('imports a labeled provider home through the main-owned picker', async () => {
    grokApi.import.mockResolvedValue({ accounts: [], activeAccountId: null })
    render(<ManagedCliHomeAccountsControl provider="gemini" />)
    await waitFor(() => expect(grokApi.list).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Personal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose home…' }))

    await waitFor(() => expect(grokApi.import).toHaveBeenCalledWith({ label: 'Personal' }))
  })
})
